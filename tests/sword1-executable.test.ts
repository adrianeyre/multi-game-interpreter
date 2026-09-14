/**
 * The two tables Broken Sword keeps in its interpreter, found in the file that
 * ships beside the clusters.
 *
 * For a long time this project said the room table "lived in Revolution's
 * interpreter rather than in the game's files, so there is nowhere to write a
 * change", and recorded the surface as editable-and-not-writable on the
 * strength of it. The first half is true and the second was an assumption that
 * had never been tested: **the interpreter is in the install.** `SWORD.EXE`
 * sits in the same folder as `swordres.rif`, with `WINSWORD.EXE` and
 * `RUNSWORD.EXE` next to it.
 *
 * So there are two claims here, and they are different in kind:
 *
 *  - The **finders work on bytes whose answer is known**, which is what the
 *    synthetic fixtures below are for. A finder tested only against a real
 *    executable is a finder tested against its own output.
 *  - The **real install holds what the finders say it holds**, which only a
 *    real install can answer, so those cases skip without one exactly as
 *    `sword-editor-real-install.test.ts` does.
 *
 * The layouts, stated once so the fixtures are not magic:
 *
 *  - A room definition is 15 little-endian 32-bit words — `totalLayers`,
 *    `sizeX`, `sizeY`, `gridWidth`, four layers, three grids, two palettes,
 *    two parallax — and the table is 100 of them end to end. It is *data*, so
 *    it is found by looking for it.
 *  - A start position is not a table at all. It is *code*: four
 *    `mov dword ptr [abs], imm32` instructions (`C7 05` + disp32 + imm32, ten
 *    bytes each) writing x, y, direction and place into one object's fields at
 *    base+0, +4, +12 and +8. So it is found by looking for the shape of those
 *    four writes, and a row is addressed by its ordinal among the runs.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  SWORD1_ROOM_DEF_BYTES,
  findSword1RoomTable,
  findSword1StartTable,
  patchSword1Executable,
  readSword1Executable,
  sword1ExecutableFilesIn,
  describeSword1Executable,
} from '../src/authoring/sword1/executable.js';
import { SWORD1_ROOMS } from '../src/engine/sword1/resource/swordRooms.js';
import { sword1ExecutableWithRooms, sword1ExecutableWithStarts } from './fixtureSword.js';

/** The folder this family's install is at, when the runner named one. */
function install(variable: string): string | null {
  const named = process.env[variable];
  if (!named) return null;
  const path = resolve(named);
  return existsSync(path) ? path : null;
}

const SWORD1 = install('MGI_SWORD1_INSTALL');

const PLACEMENTS = [
  { x: 481, y: 413, direction: 4, place: 0x10000 },
  { x: 300, y: 388, direction: 2, place: 0x10001 },
  { x: 128, y: 400, direction: 7, place: 0x30004 },
  { x: -20, y: 260, direction: 0, place: 0x50002 },
  { x: 640, y: 300, direction: 6, place: 0x50003 },
  { x: 96, y: 355, direction: 1, place: 0x60000 },
  { x: 512, y: 420, direction: 3, place: 0x60001 },
  { x: 220, y: 390, direction: 5, place: 0x70000 },
  { x: 333, y: 333, direction: 2, place: 0x70001 },
];

describe('the room table, found in bytes whose answer is known', () => {
  it('finds it at the offset it was planted at, and decodes every screen', () => {
    const table = findSword1RoomTable(sword1ExecutableWithRooms(0x1234));
    expect(table).not.toBeNull();
    expect(table!.at).toBe(0x1234);
    expect(table!.rooms.length).toBe(SWORD1_ROOMS.length);
    expect(table!.agreeing).toBe(SWORD1_ROOMS.length);
    expect(table!.rooms[1]).toEqual(SWORD1_ROOMS[1]);
  });

  it('finds nothing in bytes that hold no table, rather than a plausible offset', () => {
    const noise = new Uint8Array(0x8000);
    for (let index = 0; index < noise.length; index++) noise[index] = (index * 31 + 11) & 0xff;
    expect(findSword1RoomTable(noise)).toBeNull();
  });
});

describe('the start positions, found in code whose answer is known', () => {
  it('reads each run’s four immediates back in the order the code writes them', () => {
    const starts = findSword1StartTable(sword1ExecutableWithStarts(0x7f24, PLACEMENTS));
    expect(starts).not.toBeNull();
    expect(starts!.address).toBe(0x7f24);
    expect(starts!.placements.length).toBe(PLACEMENTS.length);
    starts!.placements.forEach((placement, index) => {
      const wanted = PLACEMENTS[index]!;
      expect({
        x: placement.x,
        y: placement.y,
        direction: placement.direction,
        place: placement.place,
      }).toEqual(wanted);
    });
  });

  it('finds nothing when there are too few runs to be the table', () => {
    expect(
      findSword1StartTable(sword1ExecutableWithStarts(0x7f24, PLACEMENTS.slice(0, 2))),
    ).toBeNull();
  });
});

describe('patching, which is what makes the row writable rather than only readable', () => {
  it('writes nothing at all when the edits are what the file already holds', () => {
    const bytes = sword1ExecutableWithStarts(0x7f24, PLACEMENTS);
    const executable = readSword1Executable('FIXTURE.EXE', bytes);
    const patched = patchSword1Executable(executable, {
      startPositions: executable.starts!.placements.map((placement) => ({
        index: placement.index,
        place: placement.place,
        x: placement.x,
        y: placement.y,
        direction: placement.direction,
      })),
    });
    expect(patched.edits).toEqual([]);
    expect(Array.from(patched.data)).toEqual(Array.from(bytes));
  });

  it('changes exactly the four bytes of the field it was asked to change', () => {
    const bytes = sword1ExecutableWithStarts(0x7f24, PLACEMENTS);
    const executable = readSword1Executable('FIXTURE.EXE', bytes);
    const first = executable.starts!.placements[0]!;
    const patched = patchSword1Executable(executable, {
      startPositions: [{ ...first, x: first.x + 64 }],
    });
    expect(patched.edits.length).toBe(1);
    expect(patched.edits[0]!.at).toBe(first.at + 6);
    expect(patched.edits[0]!.from).toBe(first.x);
    expect(patched.edits[0]!.to).toBe(first.x + 64);

    const differing: number[] = [];
    for (let at = 0; at < bytes.length; at++) {
      if (bytes[at] !== patched.data[at]) differing.push(at);
    }
    // 481 -> 545 is 0x1e1 -> 0x221, so two of the field's four bytes change
    // value; what is asserted is that none of them is outside the field.
    expect(differing.every((at) => at >= first.at + 6 && at < first.at + 10)).toBe(true);
    expect(readSword1Executable('FIXTURE.EXE', patched.data).starts!.placements[0]!.x).toBe(
      first.x + 64,
    );
  });

  it('refuses a placement whose object is not the one at that ordinal', () => {
    const executable = readSword1Executable(
      'FIXTURE.EXE',
      sword1ExecutableWithStarts(0x7f24, PLACEMENTS),
    );
    expect(() =>
      patchSword1Executable(executable, {
        startPositions: [{ index: 0, place: 0x999, x: 1, y: 2, direction: 3 }],
      }),
    ).toThrow(/places the player on compact/);
  });

  it('changes only the screen a room edit names, by number and not by position', () => {
    const bytes = sword1ExecutableWithRooms(0x1234);
    const executable = readSword1Executable('FIXTURE.EXE', bytes);
    const patched = patchSword1Executable(executable, {
      rooms: [
        { screen: 3, room: { ...SWORD1_ROOMS[3]!, gridWidth: SWORD1_ROOMS[3]!.gridWidth + 1 } },
      ],
    });
    expect(patched.edits.length).toBe(1);
    expect(patched.edits[0]!.what).toBe("screen 3's gridWidth");
    expect(patched.edits[0]!.at).toBe(0x1234 + 3 * SWORD1_ROOM_DEF_BYTES + 12);
  });
});

describe.runIf(SWORD1)('the install’s own executables', () => {
  it('names the three the game ships, in the order a reader should try them', () => {
    const names = sword1ExecutableFilesIn(listing(SWORD1!));
    expect(names.map((name) => name.toUpperCase())).toEqual([
      'SWORD.EXE',
      'WINSWORD.EXE',
      'RUNSWORD.EXE',
    ]);
  });

  it('holds the room table and the start positions in SWORD.EXE, and in only one of the others', () => {
    const read = (name: string) =>
      readSword1Executable(name, new Uint8Array(readFileSync(join(SWORD1!, name))));

    const dos = read('SWORD.EXE');
    expect(dos.rooms).not.toBeNull();
    expect(dos.rooms!.rooms.length).toBe(100);
    // Not 100 of 100, and that is the point of carrying the number: this demo's
    // clusters number six screens' resources differently from the retail game
    // the built-in table was written from, so an import that read the built-in
    // table would show an author screens this install does not have.
    expect(dos.rooms!.agreeing).toBeGreaterThanOrEqual(90);
    expect(dos.rooms!.agreeing).toBeLessThan(100);
    expect(dos.starts).not.toBeNull();
    expect(dos.starts!.placements.length).toBeGreaterThanOrEqual(40);
    expect(describeSword1Executable(dos)).toMatch(/room table/);

    const windows = read('WINSWORD.EXE');
    expect(windows.rooms).not.toBeNull();
    expect(windows.starts).not.toBeNull();
    // A different build, so a different count — which is why a placement edit
    // goes back into the file it was read out of and nowhere else.
    expect(windows.starts!.placements.length).not.toBe(dos.starts!.placements.length);

    // The launcher, which holds neither and is carried through an export
    // untouched.
    const runner = read('RUNSWORD.EXE');
    expect(runner.rooms).toBeNull();
    expect(runner.starts).toBeNull();
  });
});

/** The install's file names, which is all `sword1ExecutableFilesIn` wants. */
function listing(folder: string): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.isFile()) names.push(entry.name);
  }
  return names;
}
