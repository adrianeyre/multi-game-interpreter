/**
 * Lure's hotspot positions, read from the game's own executable.
 *
 * The first typed part of this family's object table, and the reason its
 * editable surface is no longer palettes alone.
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  LURE_DATA_SEGMENT,
  LURE_WALK_TO_OFFSET,
  LURE_WALK_TO_BYTES,
  LureHotspotError,
  parseLureWalkTo,
  writeLureWalkTo,
  looksLikeLureExecutable,
} from '../src/engine/lure/resource/lureHotspots.js';
import { editLureHotspot } from '../src/authoring/lure/project.js';

/**
 * An executable-shaped fixture with a table at the real offset.
 *
 * Built from the format rather than from what the parser accepts, which is the
 * distinction `verifying-version-support.md` calls Tier 1's trap.
 */
function buildExecutable(records: Array<{ id: number; x: number; y: number }>): Uint8Array {
  const start = LURE_DATA_SEGMENT + LURE_WALK_TO_OFFSET;
  const out = new Uint8Array(start + (records.length + 1) * LURE_WALK_TO_BYTES);
  out[0] = 0x4d;
  out[1] = 0x5a;
  const view = new DataView(out.buffer);
  records.forEach((record, index) => {
    const at = start + index * LURE_WALK_TO_BYTES;
    view.setUint16(at, record.id, true);
    view.setInt16(at + 2, record.x, true);
    view.setUint16(at + 4, record.y, true);
  });
  return out;
}

describe('parseLureWalkTo', () => {
  it('reads id, x, and y with its top bit split off as a flag', () => {
    // y's top bit is a flag: 33059 masks to 291, which is a point on screen.
    const records = parseLureWalkTo(
      buildExecutable([
        { id: 1048, x: 323, y: 33059 },
        { id: 30012, x: 365, y: 270 },
      ]),
    );
    expect(records).toEqual([
      { id: 1048, x: 323, y: 291, yFlag: true },
      { id: 30012, x: 365, y: 270, yFlag: false },
    ]);
  });

  it('stops at a zero id and reads no further', () => {
    const exe = buildExecutable([{ id: 7, x: 1, y: 2 }]);
    expect(parseLureWalkTo(exe)).toHaveLength(1);
  });

  it('refuses a file that is not the executable', () => {
    expect(() => parseLureWalkTo(new Uint8Array(16))).toThrow(LureHotspotError);
    expect(looksLikeLureExecutable(new Uint8Array(16))).toBe(false);
  });

  /**
   * The check that makes this a reading rather than a guess. A wrong anchor
   * finds bytes of the right length that mean nothing, which is the failure
   * that never errors — so the coordinates have to be screen-shaped.
   */
  it('refuses a table found at the right length and the wrong place', () => {
    expect(() => parseLureWalkTo(buildExecutable([{ id: 1, x: 30000, y: 12 }]))).toThrow(
      /off any screen/,
    );
  });

  it('refuses an empty table rather than reporting none', () => {
    expect(() => parseLureWalkTo(buildExecutable([]))).toThrow(/data segment is not/);
  });
});

describe('writeLureWalkTo', () => {
  const exe = (): Uint8Array =>
    buildExecutable([
      { id: 1048, x: 323, y: 33059 },
      { id: 30012, x: 365, y: 270 },
    ]);

  it('is byte-identical when nothing moved, flags included', () => {
    const bytes = exe();
    expect(writeLureWalkTo(bytes, parseLureWalkTo(bytes))).toEqual(bytes);
  });

  it('writes a moved hotspot and leaves its flag alone', () => {
    const bytes = exe();
    const moved = editLureHotspot(parseLureWalkTo(bytes), 1048, { x: 100, y: 50 });
    const written = writeLureWalkTo(bytes, moved);
    const back = parseLureWalkTo(written);
    expect(back[0]).toEqual({ id: 1048, x: 100, y: 50, yFlag: true });
    expect(back[1]).toEqual({ id: 30012, x: 365, y: 270, yFlag: false });
  });

  it('refuses a table that gained, lost or renumbered a record', () => {
    const bytes = exe();
    const records = parseLureWalkTo(bytes);
    expect(() => writeLureWalkTo(bytes, records.slice(0, 1))).toThrow(/count is fixed/);
    expect(() => writeLureWalkTo(bytes, [{ ...records[0], id: 99 }, records[1]])).toThrow(
      /does not renumber/,
    );
    expect(() => editLureHotspot(records, 4242, { x: 0, y: 0 })).toThrow(/no hotspot 4242/);
  });
});

/**
 * And the same against the shipped executable, which is the only evidence that
 * matters: a fixture encodes this project's reading of the format, so a fixture
 * and the reader agree by construction.
 */
describe('the shipped executable', () => {
  const path = join(process.cwd(), 'games', 'lure-of-the-temptress', 'Lure.exe');

  // The guard names the executable rather than its folder: `games/<slug>/` is
  // tracked for its README and cover art, so the folder is always there.
  const present = existsSync(path);

  it.skipIf(!present)('holds 125 positions, 122 of them in the game’s own id bands', async () => {
    const records = parseLureWalkTo(new Uint8Array(await readFile(path)));
    expect(records).toHaveLength(125);

    const inBand = records.filter(
      (record) =>
        (record.id >= 997 && record.id <= 1100) ||
        (record.id >= 10000 && record.id <= 10100) ||
        (record.id >= 30000 && record.id <= 30100),
    );
    // create_lure names Lure's id ranges as 0x3e8, 0x408, 0x2710 and 0x7530.
    // A misplaced anchor scatters ids across the whole 16-bit range instead.
    expect(inBand).toHaveLength(122);
  });

  it.skipIf(!present)('round-trips byte-identically, and one move changes one byte', async () => {
    const bytes = new Uint8Array(await readFile(path));
    const records = parseLureWalkTo(bytes);
    expect(writeLureWalkTo(bytes, records)).toEqual(bytes);

    const moved = editLureHotspot(records, records[3].id, {
      x: records[3].x + 5,
      y: records[3].y,
    });
    const written = writeLureWalkTo(bytes, moved);
    let changed = 0;
    for (let i = 0; i < bytes.length; i += 1) if (written[i] !== bytes[i]) changed += 1;
    expect(changed).toBe(1);
    expect(parseLureWalkTo(written)[3].x).toBe(records[3].x + 5);
  });
});
