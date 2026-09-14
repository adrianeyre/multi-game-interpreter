import { describe, expect, it } from 'vitest';

import { assembleClassic, disassembleClassic } from '../src/authoring/disassembleClassic.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import type { DetectedGame } from '../src/engine/resource/GameDetector.js';
import { ResourceManager } from '../src/engine/resource/ResourceManager.js';
import { Room, type RoomObject } from '../src/engine/room/Room.js';

/**
 * A synthetic v3 install: `00.LFL` and one file per room.
 *
 * Tier 1, and this one is *only* Tier 1 — there is no v3 game on this machine,
 * so the reading below is taken from ScummVM's `ScummEngine_v3old::readIndexFile`
 * and `readResTypeList` rather than measured against a shipped game. The trap
 * `verifying-version-support.md` names applies in full: this fixture encodes
 * that reading, so it and the reader agree with each other and nothing here
 * establishes that they agree with Indy 3.
 *
 * What it does pin is the shape v3 differs from v4 in, which is what a later
 * correction would have to move: no container, a one byte count where v4 has
 * two, sixteen bit offsets where v4 has thirty-two, and no room-number column
 * in the room directory because a room's number is its file's name.
 */

function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function small(tag: string, payload: number[]): number[] {
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

/** A room file: the `RO` block at offset zero, then a script after it. */
function roomFile(): { bytes: Uint8Array; scriptOffset: number } {
  const ro = small('RO', small('HD', [...u16(320), ...u16(200), ...u16(0)]));
  const script = small('SC', [0x1c, 0x03, 0x00]);
  return { bytes: new Uint8Array([...ro, ...script]), scriptOffset: ro.length };
}

function buildIndex(scriptOffset: number): Uint8Array {
  const objects = 3;
  return new Uint8Array([
    ...u16(0x0100),
    ...u16(objects),
    // Three class bytes and a packed owner/state byte each.
    0x34,
    0x12,
    0x00,
    0x21,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    // Rooms: a count, a room-number column that carries nothing but is still
    // written, then one offset each. ScummVM seeks past that column rather
    // than reading it, which is not the same as it not being there.
    2,
    0,
    1,
    ...u16(0),
    ...u16(0),
    // Costumes: a count, a room number each, then an offset each.
    1,
    0,
    ...u16(0),
    // Scripts.
    2,
    0,
    1,
    ...u16(0),
    ...u16(scriptOffset),
    // Sounds.
    1,
    0,
    ...u16(0),
  ]);
}

const V3_GAME: DetectedGame = {
  indexFile: '00.LFL',
  dataFiles: ['01.LFL'],
  charsetFiles: ['99.LFL'],
  layout: 'lfl-rooms',
  xorKey: 0xff,
  dataXorKey: 0xff,
  version: 3,
  id: 'test',
  identification: 'index-structure',
};

function xored(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ 0xff;
  return out;
}

async function load(): Promise<ResourceManager> {
  const room = roomFile();
  const source = new MemoryDataSource('v3', [
    ['00.LFL', xored(buildIndex(room.scriptOffset))],
    ['01.LFL', xored(room.bytes)],
    ['99.LFL', xored(new Uint8Array([4, 0, 1, 2, 3, 4]))],
  ]);
  return ResourceManager.load(source, V3_GAME);
}

describe('reading a SCUMM v3 install', () => {
  it('finds a room by its file name rather than through a container', async () => {
    const resources = await load();
    expect(resources.listRooms()).toEqual([1]);
    expect(resources.getRoom(1)).not.toBeNull();
  });

  it('reads a resource at an offset measured from the file', async () => {
    // v4 counts from the room's `RO` block inside an `LF`; v3 has no `LF`, so
    // the offset is simply an offset into the room's own file.
    const resources = await load();
    const script = resources.getScript(1);

    expect(script).not.toBeNull();
    expect(Array.from(script!.subarray(6))).toEqual([0x1c, 0x03, 0x00]);
  });

  it('reads directories with one byte counts and sixteen bit offsets', async () => {
    const resources = await load();
    expect(resources.limits.numScripts).toBe(2);
    expect(resources.limits.numRooms).toBe(2);
  });

  it('reads the global object table as v4 does', async () => {
    const resources = await load();
    expect(resources.limits.numGlobalObjects).toBe(3);
    expect(resources.classData[0]).toBe(0x001234);
    expect(resources.objectOwner[0]).toBe(1);
    expect(resources.objectState[0]).toBe(2);
  });

  it('reads a charset from its own file, two bytes further in than v4', async () => {
    const resources = await load();
    expect(resources.getCharset(0)).not.toBeNull();
  });
});

describe('the SCUMM v3 opcode delta', () => {
  it('sets box flags where v4 and v5 run the box matrix operations', () => {
    // The second operand has no mode bit of its own — a plain literal byte —
    // which is what makes it a different instruction rather than a narrowing.
    const code = new Uint8Array([0x30, 0x02, 0x40, 0x00]);
    const v3 = disassembleClassic(code, 3);

    expect(v3.instructions[0].name).toBe('setBoxFlags');
    expect(v3.instructions[0].length).toBe(3);
    expect(disassembleClassic(code, 4).instructions[0].name).toBe('matrixOps');
  });

  it('waits for an actor where v4 and v5 read a scale into a variable', () => {
    // Two bytes at v3 — an actor and nothing else — against four at v4, where
    // the same number is a getter and carries a result position.
    const code = new Uint8Array([0x3b, 0x0a, 0x00, 0x01, 0x00]);

    const v3 = disassembleClassic(code, 3);
    expect(v3.instructions[0].name).toBe('waitForActor');
    expect(v3.instructions[0].length).toBe(2);

    const v4 = disassembleClassic(code, 4);
    expect(v4.instructions[0].name).toBe('getActorScale');
    expect(v4.instructions[0].length).toBe(4);
  });

  it('has waitForSentence at the number v4 leaves empty', () => {
    expect(disassembleClassic(new Uint8Array([0x4c, 0x00]), 3).reason).toBeNull();
    expect(disassembleClassic(new Uint8Array([0x4c, 0x00]), 4).reason).toMatch(
      /no instruction for/,
    );
  });

  it('reads roomOps operands before the sub-opcode, not after', () => {
    // Same instruction, same operands, opposite order. A reader taking v4's
    // order on a v3 game reads the sub-opcode out of the middle of the first
    // operand and then reads two more from wherever that leaves it.
    const code = new Uint8Array([0x33, 0x0a, 0x00, 0x14, 0x00, 0x01, 0x00]);
    const v3 = disassembleClassic(code, 3);

    expect(v3.instructions[0].name).toBe('roomOps');
    expect(v3.instructions[0].length).toBe(6);
    expect(v3.instructions[1].name).toBe('stopObjectCode');
  });

  it('initialises the charset with two bytes where v4 writes a colour table', () => {
    const code = new Uint8Array([0x2c, 0x0e, 0x01, 0x02, 0x00]);
    expect(disassembleClassic(code, 3).instructions[0].length).toBe(4);
  });

  it('keeps everything v2, v3 and v4 share', () => {
    // `ifState` is the clearest: v5 reads an object's state at 0x0f and every
    // Version before it branches on it there.
    const code = new Uint8Array([0x0f, 0x0a, 0x00, 0x01, 0x05, 0x00, 0x00]);
    expect(disassembleClassic(code, 3).instructions[0].name).toBe('ifState');
  });
});

describe('reading a SCUMM v2 install', () => {
  /**
   * v2 shares v3's layout and differs in one field width, which is the same
   * fact `GameDetector` decides the Version on: v2 spends one byte per global
   * object where v3 spends four.
   */
  function buildV2Index(scriptOffset: number): Uint8Array {
    // Enough objects for the two readings to diverge. On a table of three they
    // can walk to the same end, and detection then has two answers rather than
    // one — which is a property of a tiny file, not of a real release, where
    // there are seven or eight hundred.
    const objects = 100;
    return new Uint8Array([
      ...u16(0x0100),
      ...u16(objects),
      // One packed owner/state byte each — no class data in a v2 index at all.
      0x21,
      ...new Array(objects - 1).fill(0x10),
      // Rooms: a count, the column ScummVM seeks past, then the offsets.
      1,
      0,
      ...u16(0),
      1,
      0,
      ...u16(0),
      2,
      0,
      1,
      ...u16(0),
      ...u16(scriptOffset),
      1,
      0,
      ...u16(0),
    ]);
  }

  const V2_GAME: DetectedGame = {
    indexFile: '00.LFL',
    dataFiles: ['01.LFL'],
    charsetFiles: [],
    layout: 'lfl-rooms',
    xorKey: 0,
    dataXorKey: 0,
    version: 2,
    id: 'maniac',
    identification: 'index-structure',
  };

  it('reads one byte per global object where v3 reads four', async () => {
    const room = roomFile();
    const source = new MemoryDataSource('v2', [
      ['00.LFL', buildV2Index(room.scriptOffset)],
      ['01.LFL', room.bytes],
    ]);
    const resources = await ResourceManager.load(source, V2_GAME);

    expect(resources.limits.numGlobalObjects).toBe(100);
    expect(resources.objectOwner[0]).toBe(1);
    expect(resources.objectState[0]).toBe(2);
    // Reading v3's four-byte records here would consume the directories that
    // follow, and the script count would come out of the middle of them.
    expect(resources.limits.numScripts).toBe(2);
  });

  it('finds its rooms and resources the same way v3 does', async () => {
    const room = roomFile();
    const source = new MemoryDataSource('v2', [
      ['00.LFL', buildV2Index(room.scriptOffset)],
      ['01.LFL', room.bytes],
    ]);
    const resources = await ResourceManager.load(source, V2_GAME);

    expect(resources.listRooms()).toEqual([1]);
    expect(resources.getScript(1)).not.toBeNull();
  });
});

describe('the SCUMM v2 opcode table', () => {
  /**
   * v2 is the one Classic Version whose table is written out rather than
   * layered over a later one, and these are the differences that make that
   * necessary — each one a boundary rather than a value.
   */
  it('reads a variable reference as one byte, not two', () => {
    // The widest-reaching difference in the encoding: every comparison, every
    // getter's destination and every operand whose mode bit is set. A reader
    // that got it wrong would misread the first instruction touching a
    // variable and everything after it.
    const code = new Uint8Array([0x1a, 0x0a, 0x2c, 0x01, 0x00]);
    const v2 = disassembleClassic(code, 2);

    expect(v2.instructions[0].name).toBe('move');
    expect(v2.instructions[0].length).toBe(4);
    // The same bytes are not even a whole instruction at v5, where the
    // destination is a word — and this one has the indexed bit set, so it
    // carries a subscript too. Four bytes against seven.
    expect(disassembleClassic(code, 5).reason).toMatch(/ends mid-instruction/);
  });

  it('spends sixteen opcodes on object state where v5 spends two', () => {
    // v5 passes a state as an operand; v2 bakes it into the number.
    expect(disassembleClassic(new Uint8Array([0x07, 0x0a, 0x00]), 2).instructions[0].name).toBe(
      'setStateIntrinsicOn',
    );
    expect(disassembleClassic(new Uint8Array([0x27, 0x0a, 0x00]), 2).instructions[0].name).toBe(
      'setStateLocked',
    );
    // 0x07 is `setState` at v5 and takes an object *and* a state.
    expect(
      disassembleClassic(new Uint8Array([0x07, 0x0a, 0x00, 0x01]), 5).instructions[0].name,
    ).toBe('setState');
  });

  it('branches on a state where v5 reads one into a variable', () => {
    const listing = disassembleClassic(new Uint8Array([0x0f, 0x0a, 0x00, 0x05, 0x00]), 2);
    expect(listing.instructions[0].name).toBe('ifStateIntrinsicOn');
    expect(listing.instructions[0].length).toBe(5);
  });

  it('names a bit variable with a word, where a variable is a byte', () => {
    const listing = disassembleClassic(new Uint8Array([0x1b, 0x10, 0x00, 0x02, 0x01]), 2);
    expect(listing.instructions[0].name).toBe('setBitVar');
    expect(listing.instructions[0].length).toBe(5);
  });

  it('reads verbOps as a fixed record, not an 0xFF-terminated stream', () => {
    // Measuring this one as v3's runs off the end of the record and into the
    // instruction after it, hunting for a terminator that is not there.
    const code = new Uint8Array([
      0x7a, 0x01, 0x02, 0x10, 0x20, 0x0f, 0x4f, 0x70, 0x65, 0x6e, 0x00, 0x00,
    ]);
    const listing = disassembleClassic(code, 2);

    expect(listing.instructions[0].name).toBe('verbOps');
    expect(listing.instructions[0].length).toBe(11);
    expect(listing.instructions[1].name).toBe('stopObjectCode');
  });

  it('reads roomOps operands before the sub-opcode, as v3 does', () => {
    const listing = disassembleClassic(new Uint8Array([0x33, 0x01, 0x02, 0x03, 0x00]), 2);
    expect(listing.instructions[0].length).toBe(4);
  });

  it('steps over a bare two byte jump in beginOverride, not three', () => {
    const listing = disassembleClassic(new Uint8Array([0x58, 0x01, 0x05, 0x00, 0x00]), 2);
    expect(listing.instructions[0].length).toBe(4);
    expect(listing.instructions[1].name).toBe('stopObjectCode');
  });

  it('has no argument list on startScript, where v5 takes one', () => {
    const listing = disassembleClassic(new Uint8Array([0x42, 0x09, 0x00]), 2);
    expect(listing.instructions[0].name).toBe('startScript');
    expect(listing.instructions[0].length).toBe(2);
  });

  it('re-emits an untouched v2 script byte for byte', () => {
    const code = new Uint8Array([
      0x1a,
      0x0a,
      0x2c,
      0x01, // move
      0x07,
      0x0a,
      0x00, // setStateIntrinsicOn
      0x1e,
      0x01,
      0x14,
      0x0a, // walkActorTo, coordinates in bytes
      0x00, // stopObjectCode
    ]);
    const listing = disassembleClassic(code, 2);

    expect(listing.reason).toBeNull();
    expect(Array.from(assembleClassic(listing, code))).toEqual(Array.from(code));
  });
});

describe('the SCUMM v2 object model', () => {
  /**
   * v2 packs the last four fields of an object header into three bytes where
   * v3 and v4 spend five.
   *
   * Same header up to the parent, and then they diverge: v2's walk-to point is
   * two *bytes* in eighths of a pixel, with the height and the arrival
   * direction sharing the byte after them, where v3's is two words and a byte
   * of its own for the pair. Read one as the other and an object is the right
   * size in the wrong place, facing the wrong way — which is not a crash, and
   * is why it is worth pinning.
   */
  function objectBlock(narrow: boolean): number[] {
    const header = narrow
      ? [
          ...u16(300), // id
          0, // unused
          10, // x, in eighths
          0x85, // y with the parent-state bit set
          3, // width, in eighths
          0, // parent
          20, // walk x, in eighths
          6, // walk y, in eighths, in the low five bits
          0x39, // height in the top five bits, direction in the low three
          // The name sits past the header and the verb table: eleven bytes of
          // header from the block's sixth, then three of table.
          20, // name offset
        ]
      : [
          ...u16(300),
          0,
          10,
          0x85,
          3,
          0,
          ...u16(160), // walk x, a word
          ...u16(48), // walk y, a word
          0x39,
          22, // name offset — three bytes later, for a header three bytes longer
        ];

    const verbs = [0, 0, 0]; // an empty verb table
    const name = [...'bell'].map((c) => c.charCodeAt(0));
    return small('OC', [...header, ...verbs, ...name, 0]);
  }

  function parse(narrow: boolean): RoomObject {
    const header = small('HD', [...u16(320), ...u16(200), ...u16(1)]);
    const room = new Uint8Array(small('RO', [...header, ...objectBlock(narrow)]));
    return new Room(1, room, narrow ? 2 : 4).objects[0];
  }

  it('reads a v2 walk-to point as two bytes in eighths of a pixel', () => {
    const object = parse(true);
    expect(object.id).toBe(300);
    expect(object.walkX).toBe(160);
    expect(object.walkY).toBe(48);
  });

  it('shares the height byte with the arrival direction', () => {
    const object = parse(true);
    expect(object.height).toBe(0x38);
    expect(object.actorDir).toBe(1);
  });

  it('counts the parent state in eighths, as v2 counts everything', () => {
    expect(parse(true).parentState).toBe(8);
    expect(parse(false).parentState).toBe(1);
  });

  it('finds the name three bytes earlier than v3 does', () => {
    expect(parse(true).name).toBe('bell');
    expect(parse(false).name).toBe('bell');
  });
});
