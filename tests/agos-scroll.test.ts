import { describe, expect, it } from 'vitest';
import { decodeWideImage, type IndexedBitmap } from '../src/engine/agos/gfx/agosImage.js';
import { readU32BE } from '../src/engine/agos/gfx/vgaImages.js';
import {
  VgaMachine,
  blitWideBackdrop,
  type WideBackdrop,
} from '../src/engine/agos/gfx/VgaMachine.js';
import { VGA_OPCODE_TABLES } from '../src/engine/agos/gfx/vgaOpcodeTables.js';
import {
  AgosInterpreter,
  AgosState,
  type AgosGraphicsHooks,
} from '../src/engine/agos/script/AgosInterpreter.js';
import { OPCODE_NAMES } from '../src/engine/agos/script/opcodeNames.js';
import type { AgosTarget } from '../src/engine/agos/agosVersion.js';
import type {
  AgosInstruction,
  AgosSubroutineBlock,
} from '../src/engine/agos/script/subroutines.js';

/**
 * A room wider than the screen — Simon 2's scrolling streets and caverns.
 *
 * The format is a table of per-column offsets, each pointing at that column's
 * run-length-coded pixels; the visible 320-pixel window is cut from the decoded
 * whole by a scroll in eight-pixel columns. These tests pin the two pure steps
 * (assemble the bitmap, cut the window) and the machine's recognition of the
 * wide cel, so a change to any of them has to be a deliberate one.
 */

/** A big-endian 32-bit word, the unit the column-offset table is in. */
function be32(value: number): number[] {
  return [(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/**
 * A wide image's pixel resource: a table of column offsets, then the columns.
 *
 * Each of the `width / 8` columns is one {@link decodeColumnStrip} filling an
 * eight-wide strip with a single colour, and each table slot holds the offset
 * from its own four bytes to that strip. The colour of column *c* is `c + 1`,
 * so a decoded row reads back as the column it came from and a scroll can be
 * told apart from no scroll.
 */
function wideResource(tableAt: number, width: number, height: number): Uint8Array {
  const columns = Math.floor(width / 8);
  const strip = (colour: number): number[] => [height * 8 - 1, colour]; // one run, the whole strip
  const table: number[] = [];
  const strips: number[] = [];
  const stripsAt = tableAt + columns * 4;
  for (let column = 0; column < columns; column += 1) {
    const slot = tableAt + column * 4;
    const stripAt = stripsAt + strips.length;
    table.push(...be32(stripAt - slot));
    strips.push(...strip(column + 1));
  }
  const out = new Uint8Array(stripsAt + strips.length);
  out.set(table, tableAt);
  out.set(strips, stripsAt);
  return out;
}

describe('assembling a room wider than the screen from its column table', () => {
  it('puts each column where its offset says, at its own colour', () => {
    // Two eight-pixel columns, two rows: colour 1 then colour 2.
    const pixels = wideResource(0, 16, 2);

    const bitmap = decodeWideImage(pixels, 0, 16, 2, readU32BE);

    expect(bitmap.width).toBe(16);
    expect(bitmap.height).toBe(2);
    // Row 0: eight of colour 1, then eight of colour 2. Row 1 the same.
    expect([...bitmap.pixels.slice(0, 16)]).toEqual([
      1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2,
    ]);
    expect([...bitmap.pixels.slice(16, 32)]).toEqual([
      1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2,
    ]);
  });
});

describe('cutting the visible window from a wide backdrop at a scroll', () => {
  function backdropOf(bitmap: IndexedBitmap, clipWidth: number): WideBackdrop {
    return { bitmap, originY: 0, clipX: 0, clipY: 0, clipWidth, clipHeight: bitmap.height };
  }

  it('shows a different slice of the room as the scroll moves', () => {
    const bitmap = decodeWideImage(wideResource(0, 32, 1), 0, 32, 1, readU32BE); // four columns: 1,2,3,4
    const backdrop = backdropOf(bitmap, 16); // a two-column window

    const unscrolled = new Uint8Array(16);
    blitWideBackdrop(unscrolled, 16, 1, backdrop, 0);
    // The window opens on columns one and two.
    expect([...unscrolled.slice(0, 16)]).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2]);

    const scrolled = new Uint8Array(16);
    blitWideBackdrop(scrolled, 16, 1, backdrop, 1); // one eight-pixel column across
    // ...and now on columns two and three: the same window, a step to the right.
    expect([...scrolled.slice(0, 16)]).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3]);

    expect([...scrolled]).not.toEqual([...unscrolled]);
  });

  it('draws colour zero as part of the picture, not as a hole', () => {
    // A backdrop is opaque: unlike a sprite, its colour-zero pixels are drawn.
    const bitmap: IndexedBitmap = { width: 8, height: 1, pixels: new Uint8Array(8) };
    const target = new Uint8Array(8).fill(0x7f);
    blitWideBackdrop(target, 8, 1, backdropOf(bitmap, 8), 0);
    expect([...target]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('the machine recognises a Simon 2 cel wider than the screen', () => {
  const DRAW = VGA_OPCODE_TABLES.simon2!.findIndex((entry) => entry?.endsWith('|DRAW'));
  const RET = 0;

  /** An eight-byte image entry: a BE32 offset (top two bytes zero here), flags,
   *  height, and the width word, which is twice the byte width. */
  function imageEntry(offset: number, widthBytes: number, height: number): number[] {
    const width = widthBytes * 2;
    return [
      0,
      0,
      (offset >> 8) & 0xff,
      offset & 0xff,
      0,
      height,
      (width >> 8) & 0xff,
      width & 0xff,
    ];
  }

  /**
   * A pixel resource whose entry 1 is a wide backdrop.
   *
   * The entry points at a column table placed after the two entries; the width
   * is chosen to be over 320 so the wide path is taken and to leave room to
   * scroll (`width / 8 - 40` columns).
   */
  function widePixels(width: number, height: number): Uint8Array {
    const tableAt = 16; // two eight-byte entries precede the table
    const pixels = wideResource(tableAt, width, height);
    pixels.set([...imageEntry(0, 0, 0), ...imageEntry(tableAt, width / 2, height)], 0);
    return pixels;
  }

  function drawWide(x: number, height = 2, width = 384) {
    const pixels = widePixels(width, height);
    const target = { width: 320, height, pixels: new Uint8Array(320 * height) };
    // DRAW image=1, palette=0, x, y=0, flags=0.
    const script = [DRAW, 0, 1, 0, 0, 0, x, 0, 0, 0, RET];
    const machine = new VgaMachine(Uint8Array.from(script), pixels, 'simon2', target);
    machine.run(0);
    return { machine, target };
  }

  it('keeps the decoded room and a scroll limit of width/8 - 40', () => {
    const { machine } = drawWide(0, 2, 384);

    expect(machine.wideBackdrop).not.toBeNull();
    expect(machine.scrollXMax).toBe(384 / 8 - 40); // 48 - 40 = 8
    // The wide branch runs the backdrop path, not the ordinary blit.
    expect(machine.report.drawn).toBe(1);
  });

  it("reads the cel's x as the room's opening scroll, clamped to the limit", () => {
    // x past the limit opens at the limit rather than off the end of the room.
    const { machine } = drawWide(100, 2, 384);
    expect(machine.variables[251]).toBe(8);

    const { machine: atStart } = drawWide(0, 2, 384);
    expect(atStart.variables[251]).toBe(0);
  });

  it('opens on the leftmost columns of the room at scroll zero', () => {
    const { target } = drawWide(0, 2, 384);
    // Column 0 is colour 1, the next eight pixels colour 2, and so on.
    expect(target.pixels[0]).toBe(1);
    expect(target.pixels[8]).toBe(2);
    expect(target.pixels[16]).toBe(3);
  });

  it('leaves a cel that fits the screen on the ordinary path', () => {
    // Width 320 is the boundary: not wider than the screen, so no wide backdrop.
    const { machine } = drawWide(0, 2, 320);
    expect(machine.wideBackdrop).toBeNull();
    expect(machine.scrollXMax).toBe(0);
  });
});

const SIMON2: AgosTarget = {
  family: 'AGOS',
  version: 'Simon2',
  releaseKind: 'talkie',
  platform: 'dos',
};

const SIMON1: AgosTarget = {
  family: 'AGOS',
  version: 'Simon1',
  releaseKind: 'talkie',
  platform: 'dos',
};

function pathPosnBlock(clickX: number): AgosSubroutineBlock {
  const opcode = OPCODE_NAMES.simon2!.indexOf('os1_getPathPosn');
  if (opcode < 0) throw new Error('Simon 2 has no os1_getPathPosn');
  const instructions: AgosInstruction[] = [
    {
      opcode,
      operands: [
        { kind: 'word', value: clickX },
        { kind: 'word', value: 40 },
        { kind: 'byte', value: 3 }, // output route → variable 3
        { kind: 'byte', value: 4 }, // output point → variable 4
      ],
    },
  ];
  return {
    subroutines: [{ id: 1, lines: [{ instructions }], endMarker: 0xffff }],
    endMarker: 0xffff,
  };
}

/** A graphics stub that records the room-space x a click was matched against. */
function recordingRouter(): { hooks: AgosGraphicsHooks; matchedX: () => number } {
  let matched = -1;
  const hooks = {
    nearestRoutePoint(x: number) {
      matched = x;
      return { route: 7, point: 9 };
    },
  } as unknown as AgosGraphicsHooks;
  return { hooks, matchedX: () => matched };
}

describe('a click in a scrolled room is matched in room space', () => {
  it('adds the scroll back to the click before choosing a route, on Simon 2', () => {
    const state = new AgosState([]);
    state.write(251, 3); // scrolled three eight-pixel columns, i.e. 24 pixels
    const router = recordingRouter();
    const run = new AgosInterpreter(pathPosnBlock(10), state, SIMON2, router.hooks);

    run.run(1);

    // Click x 10 on the screen is x 34 in the room after the scroll is added.
    expect(router.matchedX()).toBe(10 + 3 * 8);
    expect(state.read(3)).toBe(7);
    expect(state.read(4)).toBe(9);
  });

  it('does not add a scroll on Simon 1, which does not scroll', () => {
    const state = new AgosState([]);
    state.write(251, 3);
    const router = recordingRouter();
    const run = new AgosInterpreter(pathPosnBlock(10), state, SIMON1, router.hooks);

    run.run(1);

    expect(router.matchedX()).toBe(10);
  });
});
