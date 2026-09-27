/**
 * A PNG onto a V56 cel: written in place when the re-encoded body fits, and
 * refused by name when it does not (row 17).
 *
 * The V56 resources here are built by this test from the record as
 * `readSciView` and ScummVM's `celobj32.cpp` read it — width, height,
 * displacement, clear key and compression at 0–9, the control stream at 24,
 * the literal stream at 28 and SCI32's row table at 32 — so what is checked is
 * that the patch, this project's reader and that table agree.
 */

import { describe, expect, it } from 'vitest';

import { patchSciV56CelPixels } from '../src/authoring/sci/sciViewCel.js';
import { readSciView } from '../src/engine/sci/gfx/SciView.js';

const RECORD = 52;
const CELS_AT = 40;

interface CelSpec {
  width: number;
  height: number;
  control: number[];
  literal: number[];
  /** Row starts in each stream, written as SCI32's table when given. */
  table?: { control: number[]; literal: number[] };
  /** Point at another cel's streams instead of owning some. */
  shareWith?: number;
  uncompressed?: number[];
}

function v56(cels: CelSpec[], { mirrorLoop = false } = {}): Uint8Array {
  const loops = mirrorLoop ? 2 : 1;
  const bytes: number[] = new Array(CELS_AT + cels.length * RECORD).fill(0);
  const put16 = (at: number, value: number) => {
    bytes[at] = value & 0xff;
    bytes[at + 1] = (value >> 8) & 0xff;
  };
  const put32 = (at: number, value: number) => {
    put16(at, value & 0xffff);
    put16(at + 2, value >>> 16);
  };
  put16(0, 16);
  bytes[2] = loops;
  bytes[12] = 16;
  bytes[13] = RECORD;
  // Loop 0 owns every cel; loop 1, when there is one, mirrors it.
  bytes[18] = 0xff;
  bytes[20] = cels.length;
  put32(18 + 12, CELS_AT);
  if (mirrorLoop) bytes[34] = 0;
  // The two V56 loops leave room at 18..49; move the records past them.
  const records: number[] = [];
  for (const [index, cel] of cels.entries()) {
    const at = CELS_AT + index * RECORD;
    records.push(at);
    put16(at, cel.width);
    put16(at + 2, cel.height);
    bytes[at + 8] = 0xff;
    bytes[at + 9] = cel.uncompressed ? 0 : 0x8a;
  }
  for (const [index, cel] of cels.entries()) {
    const at = records[index];
    if (cel.shareWith !== undefined) {
      const other = records[cel.shareWith];
      for (const field of [24, 28, 32]) {
        for (let i = 0; i < 4; i++) bytes[at + field + i] = bytes[other + field + i];
      }
      continue;
    }
    if (cel.uncompressed) {
      put32(at + 24, bytes.length);
      bytes.push(...cel.uncompressed);
      continue;
    }
    put32(at + 24, bytes.length);
    bytes.push(...cel.control);
    put32(at + 28, bytes.length);
    bytes.push(...cel.literal);
    if (cel.table) {
      put32(at + 32, bytes.length);
      const words = [...cel.table.control, ...cel.table.literal];
      for (const word of words) {
        const place = bytes.length;
        bytes.push(0, 0, 0, 0);
        put32(place, word);
      }
    }
  }
  return new Uint8Array(bytes);
}

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

/** Four by two, every pixel a literal: the roomiest body a cel this size has. */
const LITERAL_CEL: CelSpec = {
  width: 4,
  height: 2,
  control: [0x04, 0x04],
  literal: [1, 2, 3, 4, 5, 6, 7, 8],
  table: { control: [0, 1], literal: [0, 4] },
};

describe('a V56 cel whose re-encoded body fits', () => {
  it('is written over its own streams, and reads back as the pixels imported', () => {
    const view = readSciView(v56([LITERAL_CEL]));
    const cel = view.loops[0].cels[0];
    expect([...cel.pixels]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    const next = Uint8Array.from([9, 9, 9, 9, 0xff, 0xff, 3, 0xff]);
    const patched = patchSciV56CelPixels(view, cel, next, 'cel');
    if (typeof patched === 'string') throw new Error(patched);

    expect(patched.length).toBe(view.source!.length);
    expect([...readSciView(patched).loops[0].cels[0].pixels]).toEqual([...next]);
  });

  it('rewrites SCI32’s row table, so a renderer that seeks to a row finds one there', () => {
    const view = readSciView(v56([LITERAL_CEL]));
    const cel = view.loops[0].cels[0];
    const patched = patchSciV56CelPixels(
      view,
      cel,
      Uint8Array.from([9, 9, 9, 9, 0xff, 0xff, 0xff, 0xff]),
      'cel',
    ) as Uint8Array;

    // Row 0 is one repeat (one control byte, one literal); row 1 one skip.
    const table = u32(patched, cel.recordAt! + 32);
    expect([0, 1, 2, 3].map((index) => u32(patched, table + index * 4))).toEqual([0, 1, 0, 1]);
    const rleAt = u32(patched, cel.recordAt! + 24);
    expect([patched[rleAt], patched[rleAt + 1]]).toEqual([0x84, 0xc4]);
  });

  it('writes an uncompressed SCI32 cel straight over its pixels', () => {
    const view = readSciView(
      v56([{ width: 2, height: 2, control: [], literal: [], uncompressed: [1, 2, 3, 4] }]),
    );
    const patched = patchSciV56CelPixels(
      view,
      view.loops[0].cels[0],
      Uint8Array.from([4, 3, 2, 1]),
      'cel',
    ) as Uint8Array;
    expect([...readSciView(patched).loops[0].cels[0].pixels]).toEqual([4, 3, 2, 1]);
  });

  it('leaves every other byte of the View where it was', () => {
    const source = v56([LITERAL_CEL, { ...LITERAL_CEL, literal: [8, 7, 6, 5, 4, 3, 2, 1] }]);
    const view = readSciView(source);
    const patched = patchSciV56CelPixels(
      view,
      view.loops[0].cels[0],
      Uint8Array.from([1, 1, 1, 1, 1, 1, 1, 1]),
      'cel',
    ) as Uint8Array;
    const other = readSciView(patched).loops[0].cels[1];
    expect([...other.pixels]).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  });
});

describe('what a V56 import refuses, by name', () => {
  it('a body that re-encodes larger than the original occupied, with both sizes', () => {
    // A cel that was all skip occupies two control bytes and no literals.
    const view = readSciView(
      v56([{ width: 4, height: 2, control: [0xc4, 0xc4], literal: [], table: undefined }]),
    );
    const refused = patchSciV56CelPixels(
      view,
      view.loops[0].cels[0],
      Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
      'View 9 loop 0 cel 0',
    );
    expect(refused).toMatch(/^View 9 loop 0 cel 0 re-encodes to 2 control and 8 literal bytes/);
    expect(refused).toContain('occupied 2 and 0');
  });

  it('a cel whose streams another record also names', () => {
    const view = readSciView(v56([LITERAL_CEL, { ...LITERAL_CEL, shareWith: 0 }]));
    expect(
      patchSciV56CelPixels(view, view.loops[0].cels[1], new Uint8Array(8).fill(1), 'cel'),
    ).toContain('repaint both');
  });

  it('a mirrored loop’s cel, which has no record of its own', () => {
    const view = readSciView(v56([LITERAL_CEL], { mirrorLoop: true }));
    const mirrored = view.loops[1].cels[0];
    expect(mirrored.recordAt).toBeUndefined();
    expect(patchSciV56CelPixels(view, mirrored, new Uint8Array(8), 'cel')).toContain(
      'mirrored loop',
    );
  });
});
