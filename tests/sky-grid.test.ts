import { describe, expect, it } from 'vitest';
import {
  SkyGrids,
  GRID_FILE_START,
  TOT_NO_GRIDS,
  GRID_SIZE,
  GRID_COLS,
  GRID_ROWS,
} from '../src/engine/sky/resource/SkyGrid.js';
import type { SkyResources } from '../src/engine/sky/resource/SkyResources.js';

/**
 * A resources stand-in that carries the grid ids it is told to, so the test can
 * ask for a complete set, an incomplete one, or one with a wrong size — the
 * three the verdict distinguishes — without a real `sky.dsk`.
 */
function fakeResources(grids: Map<number, Uint8Array>): SkyResources {
  return {
    entry: (id: number) => (grids.has(id) ? ({} as never) : null),
    read: (id: number) => {
      const bytes = grids.get(id);
      if (!bytes) throw new Error(`no fixture for ${id}`);
      return bytes;
    },
  } as unknown as SkyResources;
}

function completeGrids(): Map<number, Uint8Array> {
  const grids = new Map<number, Uint8Array>();
  for (let slot = 0; slot < TOT_NO_GRIDS; slot += 1) {
    // A distinct fill per slot, so a mix-up between slots would show.
    grids.set(GRID_FILE_START + slot, new Uint8Array(GRID_SIZE).fill(slot & 0xff));
  }
  return grids;
}

describe('SkyGrids constants', () => {
  it('the cell count derives the shipped record size', () => {
    // 40 × 24 = 960 bits = 120 bytes. This is the tie between the layout and
    // the byte length the file actually carries.
    expect(GRID_COLS * GRID_ROWS).toBe(GRID_SIZE * 8);
  });
});

describe('SkyGrids.verify', () => {
  it('accepts a full set of correctly-sized grids', () => {
    const grids = SkyGrids.load(fakeResources(completeGrids()));
    expect(grids.count).toBe(TOT_NO_GRIDS);
    expect(grids.verify()).toEqual({ present: TOT_NO_GRIDS, sizes: [GRID_SIZE], complete: true });
  });

  it('reports a missing grid rather than pretending completeness', () => {
    const map = completeGrids();
    map.delete(GRID_FILE_START + 3);
    const verdict = SkyGrids.load(fakeResources(map)).verify();
    expect(verdict.present).toBe(TOT_NO_GRIDS - 1);
    expect(verdict.complete).toBe(false);
  });

  it('reports a wrong-sized grid', () => {
    const map = completeGrids();
    map.set(GRID_FILE_START + 5, new Uint8Array(GRID_SIZE + 8));
    const verdict = SkyGrids.load(fakeResources(map)).verify();
    expect(verdict.complete).toBe(false);
    expect(verdict.sizes).toContain(GRID_SIZE + 8);
  });
});

describe('SkyGrids.bitIndex', () => {
  it('maps every on-grid pixel to a bit and none off it', () => {
    // Sweep the whole playfield the grid covers, one pixel per cell, and prove
    // the maths a bijection onto [0, 960): every cell addressed exactly once.
    // This is the correctness the reader can hold without a running game — the
    // per-pixel *meaning* of a set bit waits on the router.
    const TOP_LEFT_X = 128;
    const TOP_LEFT_Y = 136;
    const seen = new Set<number>();
    for (let row = 0; row < GRID_ROWS; row += 1) {
      for (let col = 0; col < GRID_COLS; col += 1) {
        const bit = SkyGrids.bitIndex(TOP_LEFT_X + col * 8, TOP_LEFT_Y + row * 8);
        expect(bit).not.toBeNull();
        expect(bit!).toBeGreaterThanOrEqual(0);
        expect(bit!).toBeLessThan(GRID_COLS * GRID_ROWS);
        seen.add(bit!);
      }
    }
    expect(seen.size).toBe(GRID_COLS * GRID_ROWS);
  });

  it('returns null off the grid', () => {
    // The grid's origin is (128, 136) and it spans 320×192 from there, so
    // off-grid means left of 128, right of 448, above 136 or below 328.
    expect(SkyGrids.bitIndex(100, 150)).toBeNull(); // left of the origin
    expect(SkyGrids.bitIndex(500, 150)).toBeNull(); // right of the last column
    expect(SkyGrids.bitIndex(200, 100)).toBeNull(); // above the origin
    expect(SkyGrids.bitIndex(200, 400)).toBeNull(); // below the last row
  });
});

describe('SkyGrids.blockedAt', () => {
  it('reads a set bit back out of a grid', () => {
    // An all-ones grid: every on-grid pixel reads blocked, every off-grid one
    // reads clear (a pixel off the grid is nowhere to plot).
    const map = new Map<number, Uint8Array>();
    map.set(GRID_FILE_START, new Uint8Array(GRID_SIZE).fill(0xff));
    const grids = SkyGrids.load(fakeResources(map));
    expect(grids.blockedAt(0, 128, 136)).toBe(true);
    expect(grids.blockedAt(0, 0, 0)).toBe(false);
  });

  it('reads a clear bit as not blocked', () => {
    const map = new Map<number, Uint8Array>();
    map.set(GRID_FILE_START, new Uint8Array(GRID_SIZE));
    const grids = SkyGrids.load(fakeResources(map));
    expect(grids.blockedAt(0, 200, 150)).toBe(false);
  });
});
