/**
 * A mask layer and the grid that places it.
 *
 * A Broken Sword mask layer is not an image. It is a bag of 16x8 blocks in
 * storage order, and a separate **Grid** resource says which block goes where:
 * one 16-bit cell per block position, one-based, zero meaning "nothing here".
 * Nothing in the mask resource says where anything is, which is why drawing
 * one on its own shows 4,000 blocks in the order they happened to be stored.
 *
 * The two pieces are here rather than in `SwordScreen` because the editor needs
 * the same arithmetic the renderer does, in both directions: compose a room-
 * sized picture so an author can see the mask over its background, and take an
 * edited picture apart again into the blocks the cells point at.
 *
 * ## The imaginary screen
 *
 * The grid is indexed against a screen **128 pixels wider on each side**, so a
 * cell at grid `(gx, gy)` is at room pixel `(gx * 16 - 128, gy * 8 - 128)` and
 * a grid's pitch is `sizeX / 16 + 16`, which is what the room table calls
 * `gridWidth`. Measured on the demo, every grid is exactly `pitch` x
 * `sizeY / 8 + 32` cells.
 *
 * ## Where the cells start
 *
 * 28 bytes into the resource. ScummVM reaches them with
 * `_layerGrid[cnt] = (uint16 *)openFetchRes(id); _layerGrid[cnt] += 14;`, and
 * that pointer starts at byte 0 of the resource, so the 20-byte `Header` is
 * *inside* the 28 rather than before it. (The mask layer itself, one line up in
 * the same function, steps on by `sizeof(Header)` instead, which is the
 * asymmetry that makes this worth writing down.)
 *
 * ## Blocks are shared
 *
 * Several cells can point at the same block — a run of identical shadow is
 * stored once — so taking a picture apart can be asked to write two different
 * things into one block. That is reported rather than resolved: see
 * `decomposeSwordMask`.
 */

import { SWORD1_SCREEN_LEFT_EDGE, SWORD1_SCREEN_TOP_EDGE } from '../resource/swordDefs.js';

/** The mask grid's block size. 16 wide, 8 tall, so a block is 128 bytes. */
export const SCRNGRID_X = 16;
export const SCRNGRID_Y = 8;
export const MASK_BLOCK_BYTES = SCRNGRID_X * SCRNGRID_Y;

/** How far into a Grid resource its first cell is. Not `sizeof(Header)`. */
export const SWORD1_GRID_CELLS_AT = 28;

/** A grid's cells, and the pitch they are laid out at. */
export interface SwordGrid {
  /** One-based block indexes, row-major across the imaginary screen. */
  readonly cells: Uint16Array;
  /** Cells per row: `sizeX / 16 + 16`, the room table's `gridWidth`. */
  readonly pitch: number;
  /** How many whole rows the resource holds. */
  readonly rows: number;
}

/**
 * Reads a Grid resource's cells.
 *
 * `bigEndian` is the Mac releases' byte order; the PC ones are little-endian
 * and a `Uint16Array` view would silently be right for one and wrong for the
 * other, so the order is read rather than assumed.
 */
export function parseSwordGrid(bytes: Uint8Array, pitch: number, bigEndian = false): SwordGrid {
  const count = Math.max(0, Math.floor((bytes.length - SWORD1_GRID_CELLS_AT) / 2));
  const rows = pitch > 0 ? Math.floor(count / pitch) : 0;
  const cells = new Uint16Array(rows * pitch);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let cell = 0; cell < cells.length; cell++) {
    cells[cell] = view.getUint16(SWORD1_GRID_CELLS_AT + cell * 2, !bigEndian);
  }
  return { cells, pitch, rows };
}

/** Where a grid cell lands, in room pixels. Negative is off the left or top. */
export function swordGridCellOrigin(
  cell: number,
  pitch: number,
): { readonly x: number; readonly y: number } {
  const gx = pitch > 0 ? cell % pitch : 0;
  const gy = pitch > 0 ? Math.floor(cell / pitch) : 0;
  return {
    x: gx * SCRNGRID_X - SWORD1_SCREEN_LEFT_EDGE,
    y: gy * SCRNGRID_Y - SWORD1_SCREEN_TOP_EDGE,
  };
}

/**
 * Lays a mask's blocks out over a room-sized picture, the way the grid places
 * them. Colour zero is the mask's transparency, so untouched pixels stay zero.
 */
export function composeSwordMask(
  blocks: Uint8Array,
  grid: SwordGrid,
  width: number,
  height: number,
): Uint8Array {
  const pixels = new Uint8Array(Math.max(0, width * height));
  for (let cell = 0; cell < grid.cells.length; cell++) {
    const index = grid.cells[cell] ?? 0;
    if (index === 0) continue;
    const from = (index - 1) * MASK_BLOCK_BYTES;
    if (from + MASK_BLOCK_BYTES > blocks.length) continue;
    const { x, y } = swordGridCellOrigin(cell, grid.pitch);
    for (let row = 0; row < SCRNGRID_Y; row++) {
      const at = y + row;
      if (at < 0 || at >= height) continue;
      for (let column = 0; column < SCRNGRID_X; column++) {
        const to = x + column;
        if (to < 0 || to >= width) continue;
        pixels[at * width + to] = blocks[from + row * SCRNGRID_X + column] ?? 0;
      }
    }
  }
  return pixels;
}

/** What taking a mask apart produced, and what could not be honoured. */
export interface SwordMaskDecomposition {
  /** The blocks, edited in place from a copy of the originals. */
  readonly blocks: Uint8Array;
  /**
   * Block indexes (one-based, as the cells hold them) that two or more cells
   * wanted to fill with different pixels. The first cell wins in `blocks`;
   * a caller that cares should refuse rather than ship the compromise.
   */
  readonly conflicts: readonly number[];
  /** How many cells were written. */
  readonly written: number;
}

/**
 * Takes an edited room-sized picture back apart into the mask's blocks.
 *
 * Only the pixels a cell covers can go anywhere: a block that the grid never
 * names has no place on the screen, so paint outside every cell is dropped, and
 * a block that hangs off the room's edge keeps its off-screen bytes. Blocks
 * several cells share are reported in `conflicts` when the cells disagree —
 * the alternative is writing one of them and silently changing the other
 * places that block appears.
 */
export function decomposeSwordMask(
  blocks: Uint8Array,
  grid: SwordGrid,
  pixels: Uint8Array,
  width: number,
  height: number,
): SwordMaskDecomposition {
  const out = new Uint8Array(blocks);
  const filled = new Map<number, Uint8Array>();
  const conflicts: number[] = [];
  let written = 0;

  for (let cell = 0; cell < grid.cells.length; cell++) {
    const index = grid.cells[cell] ?? 0;
    if (index === 0) continue;
    const from = (index - 1) * MASK_BLOCK_BYTES;
    if (from + MASK_BLOCK_BYTES > out.length) continue;
    const { x, y } = swordGridCellOrigin(cell, grid.pitch);

    const block = new Uint8Array(out.subarray(from, from + MASK_BLOCK_BYTES));
    for (let row = 0; row < SCRNGRID_Y; row++) {
      const at = y + row;
      if (at < 0 || at >= height) continue;
      for (let column = 0; column < SCRNGRID_X; column++) {
        const to = x + column;
        if (to < 0 || to >= width) continue;
        block[row * SCRNGRID_X + column] = pixels[at * width + to] ?? 0;
      }
    }

    const already = filled.get(index);
    if (already) {
      if (!already.every((byte, at) => byte === block[at]) && !conflicts.includes(index)) {
        conflicts.push(index);
      }
      continue;
    }
    filled.set(index, block);
    out.set(block, from);
    written++;
  }

  return { blocks: out, conflicts, written };
}
