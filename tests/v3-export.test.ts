import { describe, expect, it } from 'vitest';

import { lflRoomFileName, rewriteLflGame } from '../src/authoring/exportLflGame.js';

/**
 * The third writer, where "rebuild the container" stops meaning anything.
 *
 * There is no container. Export is a set of files, so a resource growing does
 * not move anything after it in a larger blob — it makes one file bigger, and
 * only the offsets inside that file change.
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

const ROOM_BLOCK = small('RO', small('HD', [...u16(320), ...u16(200), ...u16(0)]));
const SCRIPT_A = small('SC', [0x1c, 0x03, 0x00]);
const SCRIPT_B = small('SC', [0x1c, 0x04, 0x00]);

const SCRIPT_A_AT = ROOM_BLOCK.length;
const SCRIPT_B_AT = ROOM_BLOCK.length + SCRIPT_A.length;

function room(): Uint8Array {
  return new Uint8Array([...ROOM_BLOCK, ...SCRIPT_A, ...SCRIPT_B]);
}

function index(): Uint8Array {
  return new Uint8Array([
    ...u16(0x0100),
    ...u16(1),
    0,
    0,
    0,
    0,
    // Rooms: one, no room-number column.
    1,
    ...u16(0),
    // Costumes: none.
    0,
    // Scripts: three, the first absent.
    3,
    0,
    1,
    1,
    ...u16(0xffff),
    ...u16(SCRIPT_A_AT),
    ...u16(SCRIPT_B_AT),
    // Sounds: none.
    0,
  ]);
}

/** The offset the index records for script `id`. */
function scriptOffset(built: Uint8Array, id: number): number {
  // Past the magic, the object count and its one four byte record, the room
  // list and the empty costume list, to the script count.
  const at = 2 + 2 + 4 + (1 + 2) + 1;
  const count = built[at];
  const entry = at + 1 + count + id * 2;
  return built[entry] | (built[entry + 1] << 8);
}

describe('writing a SCUMM v3 game back out', () => {
  it('carries an untouched room file through unchanged', () => {
    const rooms = new Map([[1, room()]]);
    const out = rewriteLflGame(index(), rooms, []);

    expect(Array.from(out.rooms.get(1)!)).toEqual(Array.from(room()));
    expect(Array.from(out.index)).toEqual(Array.from(index()));
  });

  it('moves what follows a resource that grew, inside that file only', () => {
    const rooms = new Map([[1, room()]]);
    const grown = new Uint8Array(small('SC', [0x1c, 0x03, 0x1c, 0x05, 0x00]));

    const out = rewriteLflGame(index(), rooms, [{ room: 1, offset: SCRIPT_A_AT, block: grown }]);

    expect(out.rooms.get(1)!.length).toBe(room().length + 2);
    expect(scriptOffset(out.index, 1)).toBe(SCRIPT_A_AT);
    expect(scriptOffset(out.index, 2)).toBe(SCRIPT_B_AT + 2);
  });

  it('leaves a "not present" entry pointing nowhere', () => {
    const out = rewriteLflGame(index(), new Map([[1, room()]]), [
      { room: 1, offset: SCRIPT_A_AT, block: new Uint8Array(SCRIPT_A) },
    ]);
    expect(scriptOffset(out.index, 0)).toBe(0xffff);
  });

  it('refuses an edit that would push a room past a sixteen bit offset', () => {
    // The index cannot address it, so the game would load and hand out the
    // wrong bytes. Refused by name rather than truncated.
    const huge = new Uint8Array(small('SC', new Array(70000).fill(0)));
    expect(() =>
      rewriteLflGame(index(), new Map([[1, room()]]), [
        { room: 1, offset: SCRIPT_A_AT, block: huge },
      ]),
    ).toThrow(/sixteen bit offset/);
  });

  it('names a room file after its number, which is the whole naming rule', () => {
    expect(lflRoomFileName(1)).toBe('01.LFL');
    expect(lflRoomFileName(42)).toBe('42.LFL');
  });
});
