import { describe, expect, it } from 'vitest';

import {
  rebuildSmallScriptBlock,
  replaceSmallRoomScripts,
  rewriteLecGame,
} from '../src/authoring/exportLecGame.js';

/**
 * The v4 writer, which is the same principle as the `LECF` one and a second
 * implementation of it.
 *
 * `exportGame.ts` is version-agnostic *within* `LECF`: it never asks what a
 * resource is, but it does assume a game is one file with one room directory.
 * v4 is `000.LFL` plus up to nine `DISKnn.LEC`, and a directory offset counts
 * from the `RO` block rather than from the `LF` around it — eight bytes, and
 * rebuilding with v5's convention hands every script the tail of the one
 * before it.
 */

function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

function small(tag: string, payload: number[]): number[] {
  return [...u32(payload.length + 6), tag.charCodeAt(0), tag.charCodeAt(1), ...payload];
}

/** One disk holding one room with a room block and two scripts. */
function buildDisk(): { disk: Uint8Array; scriptOffsets: number[] } {
  const roomBlock = small('RO', small('HD', [...u16(320), ...u16(200), ...u16(0)]));
  const scriptA = small('SC', [0x1c, 0x03, 0x00]);
  const scriptB = small('SC', [0x1c, 0x04, 0x00]);

  // Offsets as the index records them: from the `RO` block's first byte.
  const scriptOffsets = [roomBlock.length, roomBlock.length + scriptA.length];

  const body = [...u16(1), ...roomBlock, ...scriptA, ...scriptB];
  const directory = small('FO', [1, 1, ...u32(6 + 6 + 1 + 5)]);
  const disk = small('LE', [...directory, ...small('LF', body)]);

  return { disk: new Uint8Array(disk), scriptOffsets };
}

function buildIndex(scriptOffsets: number[]): Uint8Array {
  return new Uint8Array([
    ...small('0R', [...u16(2), 0, ...u32(0), 1, ...u32(0)]),
    ...small('0S', [
      ...u16(3),
      0,
      ...u32(0),
      1,
      ...u32(scriptOffsets[0]),
      1,
      ...u32(scriptOffsets[1]),
    ]),
    ...small('0O', [...u16(1), 0, 0, 0, 0]),
  ]);
}

/** The offset the index records for script `id` after a rewrite. */
function scriptOffsetIn(index: Uint8Array, id: number): number {
  // `0S` is the second block, and its entries are five bytes each after the
  // two byte count.
  let at = 0;
  while (at < index.length) {
    const size = index[at] | (index[at + 1] << 8) | (index[at + 2] << 16) | (index[at + 3] << 24);
    const tag = String.fromCharCode(index[at + 4], index[at + 5]);
    if (tag === '0S') {
      const entry = at + 6 + 2 + id * 5;
      return (
        index[entry + 1] |
        (index[entry + 2] << 8) |
        (index[entry + 3] << 16) |
        (index[entry + 4] << 24)
      );
    }
    at += size;
  }
  return -1;
}

describe('writing a SCUMM v4 game back out', () => {
  it('rebuilds an untouched game byte for byte', () => {
    const { disk, scriptOffsets } = buildDisk();
    const index = buildIndex(scriptOffsets);

    const out = rewriteLecGame(index, [disk], []);

    expect(Array.from(out.disks[0])).toEqual(Array.from(disk));
    expect(Array.from(out.index)).toEqual(Array.from(index));
  });

  it('moves everything after a resource that grew, and follows it in the index', () => {
    const { disk, scriptOffsets } = buildDisk();
    const index = buildIndex(scriptOffsets);

    // Script 1 gets four more bytes, so script 2 moves by four.
    const grown = new Uint8Array(small('SC', [0x1c, 0x03, 0x1c, 0x05, 0x1c, 0x06, 0x00]));
    const out = rewriteLecGame(
      index,
      [disk],
      [{ room: 1, offset: scriptOffsets[0], block: grown }],
    );

    expect(out.disks[0].length).toBe(disk.length + 4);
    expect(scriptOffsetIn(out.index, 1)).toBe(scriptOffsets[0]);
    expect(scriptOffsetIn(out.index, 2)).toBe(scriptOffsets[1] + 4);
  });

  it('leaves the room directory alone, because v4 finds rooms through FO', () => {
    // The room directory's "room number" column is really the disk number and
    // its offsets are zero. Rewriting it as though it addressed the container
    // would put a file offset where a disk number belongs.
    const { disk, scriptOffsets } = buildDisk();
    const index = buildIndex(scriptOffsets);

    const out = rewriteLecGame(index, [disk], []);
    expect(Array.from(out.index.subarray(0, 6 + 2 + 10))).toEqual(
      Array.from(index.subarray(0, 6 + 2 + 10)),
    );
  });

  it('substitutes a script inside a room without disturbing its neighbours', () => {
    const room = new Uint8Array([
      ...small('RO', [
        ...small('HD', [...u16(320), ...u16(200), ...u16(0)]),
        ...small('LS', [200, 0x1c, 0x03, 0x00]),
        ...small('EN', [0x80, 0x00]),
      ]),
    ]);

    // The `LS` block starts after the `RO` header and the `HD` block.
    const lsOffset = 6 + 6 + 6;
    const replaced = rebuildSmallScriptBlock(room, lsOffset, 1, new Uint8Array([0x1c, 0x09, 0x00]));
    const rebuilt = replaceSmallRoomScripts(room, new Map([[lsOffset, replaced]]));

    expect(rebuilt.length).toBe(room.length);
    // The script number in front of the code survives; the code changes.
    expect(rebuilt[lsOffset + 6]).toBe(200);
    expect(rebuilt[lsOffset + 8]).toBe(0x09);
    // And the block after it is untouched.
    expect(String.fromCharCode(rebuilt[lsOffset + 10 + 4], rebuilt[lsOffset + 10 + 5])).toBe('EN');
  });

  it('refuses a container that is not an LE, rather than writing nonsense', () => {
    expect(() => rewriteLecGame(new Uint8Array(0), [new Uint8Array(16)], [])).toThrow(
      /no LE block/,
    );
  });
});
