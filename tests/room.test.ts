import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { detectGame } from '../src/engine/resource/GameDetector.js';
import { ResourceManager } from '../src/engine/resource/ResourceManager.js';
import { Room } from '../src/engine/room/Room.js';
import { BoxMatrix, closestPtOnBox, closestPtOnLine } from '../src/engine/room/BoxMatrix.js';
import type { WalkBox } from '../src/engine/room/Room.js';
import { buildFixture, V5_OBJECT_VERB_OFFSET } from './fixture.js';

async function loadRoom(): Promise<Room> {
  const fixture = buildFixture();
  const source = new MemoryDataSource('fixture');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  const manager = await ResourceManager.load(source, await detectGame(source));
  return new Room(1, manager.getRoom(1)!);
}

function box(
  ulx: number,
  uly: number,
  urx: number,
  ury: number,
  lrx: number,
  lry: number,
  llx: number,
  lly: number,
  overrides: Partial<WalkBox> = {},
): WalkBox {
  return { ulx, uly, urx, ury, lrx, lry, llx, lly, mask: 0, flags: 0, scale: 255, ...overrides };
}

describe('room parsing', () => {
  it('reads the room header', async () => {
    const room = await loadRoom();
    expect(room.width).toBe(320);
    expect(room.height).toBe(144);
    expect(room.numObjects).toBe(1);
    expect(room.numZPlanes).toBe(1);
  });

  it('finds the background image', async () => {
    const room = await loadRoom();
    expect(room.backgroundOffset).toBeGreaterThan(0);
  });

  it('reads the palette', async () => {
    const room = await loadRoom();
    expect(room.palette).not.toBeNull();
    expect(room.palette!.length).toBe(768);
  });

  it('reads walk boxes', async () => {
    const room = await loadRoom();
    expect(room.boxes).toHaveLength(2);
    expect(room.boxes[0].ulx).toBe(0);
    expect(room.boxes[0].uly).toBe(100);
    expect(room.boxes[0].lry).toBe(140);
  });

  it('reads colour cycles and converts the rate to a delay', async () => {
    const room = await loadRoom();
    expect(room.cycles).toHaveLength(1);
    expect(room.cycles[0].start).toBe(16);
    expect(room.cycles[0].end).toBe(31);
    expect(room.cycles[0].delay).toBeGreaterThan(0);
  });

  it('reads the transparent colour', async () => {
    const room = await loadRoom();
    expect(room.transparentColor).toBe(255);
  });

  it('parses objects with their geometry, name and verbs', async () => {
    const room = await loadRoom();
    expect(room.objects).toHaveLength(1);

    const object = room.objects[0];
    expect(object.id).toBe(500);
    expect(object.x).toBe(32); // 4 * 8
    expect(object.y).toBe(64); // 8 * 8
    expect(object.width).toBe(16);
    expect(object.height).toBe(16);
    expect(object.walkX).toBe(40);
    expect(object.walkY).toBe(120);
    expect(object.name).toBe('brass lamp');
    expect(object.verbs.get(1)).toBe(V5_OBJECT_VERB_OFFSET);
    expect(object.image?.hotspots[0]).toEqual({ x: 4, y: 8 });
  });

  it('finds entry, exit and local scripts', async () => {
    const room = await loadRoom();
    expect(room.scripts.entry).not.toBeNull();
    expect(room.scripts.exit).not.toBeNull();
    expect(room.scripts.local.has(200)).toBe(true);
  });
});

describe('line projection', () => {
  it('projects onto a vertical segment', () => {
    expect(closestPtOnLine({ x: 10, y: 0 }, { x: 10, y: 100 }, { x: 50, y: 40 })).toEqual({
      x: 10,
      y: 40,
    });
  });

  it('projects onto a horizontal segment', () => {
    expect(closestPtOnLine({ x: 0, y: 10 }, { x: 100, y: 10 }, { x: 40, y: 90 })).toEqual({
      x: 40,
      y: 10,
    });
  });

  it('clamps to the segment ends', () => {
    expect(closestPtOnLine({ x: 0, y: 10 }, { x: 100, y: 10 }, { x: -50, y: 10 })).toEqual({
      x: 0,
      y: 10,
    });
  });

  it('finds the nearest edge of a box', () => {
    const corners = {
      ul: { x: 0, y: 0 },
      ur: { x: 100, y: 0 },
      lr: { x: 100, y: 100 },
      ll: { x: 0, y: 100 },
    };
    const { point } = closestPtOnBox(corners, { x: 50, y: -20 });
    expect(point).toEqual({ x: 50, y: 0 });
  });
});

describe('walk boxes', () => {
  const boxes = [
    box(0, 100, 320, 100, 320, 140, 0, 140),
    box(0, 60, 320, 60, 320, 100, 0, 100),
    box(0, 0, 320, 0, 320, 40, 0, 40), // separated from the others by a gap
  ];

  it('tests containment', () => {
    const matrix = new BoxMatrix(boxes);
    expect(matrix.contains(0, 160, 120)).toBe(true);
    expect(matrix.contains(0, 160, 50)).toBe(false);
    expect(matrix.contains(1, 160, 80)).toBe(true);
  });

  it('rejects out-of-range box numbers', () => {
    const matrix = new BoxMatrix(boxes);
    expect(matrix.contains(-1, 0, 0)).toBe(false);
    expect(matrix.contains(99, 0, 0)).toBe(false);
  });

  it('detects boxes that share an edge', () => {
    const matrix = new BoxMatrix(boxes);
    expect(matrix.areNeighbors(0, 1)).toBe(true);
    expect(matrix.areNeighbors(1, 2)).toBe(false);
  });

  it('never treats an invisible box as a neighbour', () => {
    const withInvisible = [boxes[0], { ...boxes[1], flags: 0x80 }];
    const matrix = new BoxMatrix(withInvisible);
    expect(matrix.areNeighbors(0, 1)).toBe(false);
  });

  it('routes through adjacent boxes and reports unreachable ones', () => {
    const matrix = new BoxMatrix(boxes);
    expect(matrix.getNextBox(0, 1)).toBe(1);
    expect(matrix.getNextBox(0, 0)).toBe(0);
    expect(matrix.getNextBox(0, 2)).toBe(-1);
  });

  it('routes transitively across a chain of boxes', () => {
    const chain = [
      box(0, 100, 100, 100, 100, 140, 0, 140),
      box(0, 60, 100, 60, 100, 100, 0, 100),
      box(0, 20, 100, 20, 100, 60, 0, 60),
    ];
    const matrix = new BoxMatrix(chain);
    // Getting from the bottom box to the top one must go via the middle.
    expect(matrix.getNextBox(0, 2)).toBe(1);
  });

  it('snaps an off-box point onto the nearest box', () => {
    const matrix = new BoxMatrix(boxes);
    const adjusted = matrix.adjustToBeInBox(160, 200);
    expect(adjusted.box).toBe(0);
    expect(adjusted.y).toBe(140);
  });

  it('finds the highest numbered box containing a point', () => {
    const overlapping = [
      box(0, 0, 320, 0, 320, 200, 0, 200),
      box(0, 100, 320, 100, 320, 140, 0, 140),
    ];
    const matrix = new BoxMatrix(overlapping);
    expect(matrix.findBoxAt(160, 120)).toBe(1);
  });

  it('reads a literal box scale', () => {
    const matrix = new BoxMatrix([box(0, 0, 10, 0, 10, 10, 0, 10, { scale: 128 })]);
    expect(matrix.getScale(0, 5, 5)).toBe(128);
  });

  it('interpolates a scale from a slot when bit 15 is set', () => {
    const matrix = new BoxMatrix(
      [box(0, 0, 10, 0, 10, 200, 0, 200, { scale: 0x8000 })],
      [{ scale1: 100, y1: 0, scale2: 200, y2: 100, x1: 0, x2: 0 }],
    );
    expect(matrix.getScale(0, 0, 0)).toBe(100);
    expect(matrix.getScale(0, 0, 100)).toBe(200);
    expect(matrix.getScale(0, 0, 50)).toBe(150);
  });
});
