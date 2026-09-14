/**
 * A Broken Sword II walk grid resource, taken apart and put back together.
 *
 * The bars and the nodes are the same codec Broken Sword used — twenty-four
 * bytes a bar, four a node, the same fields in the same order — so they are
 * read and written by `swordWalkGrid.ts` rather than a second time here. That
 * is ADR 0036's amendment applied as written: **a widget or a codec may cross;
 * a record may not.** `sword2Encode.ts` already imports the "Tony" compressor
 * from Sword 1's encoder on exactly this footing.
 *
 * What does not cross is the container, which is why this file exists at all:
 *
 * - A Sword 1 grid has a 20-byte resource header and then a **scale ramp** the
 *   router ignores, so its counts begin 28 bytes in. A Sword II grid has a
 *   44-byte resource header and its counts begin straight after it.
 * - A Sword 1 screen has exactly one grid, named by a floor compact's
 *   `o_resource`. A Sword II screen has as many as its scripts add: the router
 *   concatenates every grid `fnAddWalkGrid` registered for the session, so the
 *   bars of three resources are one wall to a walking mega.
 * - A Sword II header's two length words are zero on every grid in the demo,
 *   so unlike Sword 1's there is nothing in them to correct when a grid loses
 *   a bar.
 */

import {
  readSwordWalkBars,
  readSwordWalkNodes,
  writeSwordWalkBars,
  writeSwordWalkNodes,
  SWORD_BAR_BYTES,
  SWORD_NODE_BYTES,
  type SwordWalkBar,
  type SwordWalkNode,
} from '../../sword1/script/swordWalkGrid.js';
import { RES_HEADER_SIZE } from '../resource/sword2Headers.js';

/** One Broken Sword II walk grid resource. No scale ramp: Sword 1 has that. */
export interface Sword2WalkGrid {
  readonly bars: readonly SwordWalkBar[];
  readonly nodes: readonly SwordWalkNode[];
}

/** How long a Sword II grid resource with these counts is. */
export function sword2WalkGridBytes(bars: number, nodes: number): number {
  return RES_HEADER_SIZE + 8 + bars * SWORD_BAR_BYTES + nodes * SWORD_NODE_BYTES;
}

/** Reads a grid resource, or null when the bytes are not one. */
export function parseSword2WalkGrid(bytes: Uint8Array): Sword2WalkGrid | null {
  if (bytes.length < RES_HEADER_SIZE + 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const barCount = view.getInt32(RES_HEADER_SIZE, true);
  const nodeCount = view.getInt32(RES_HEADER_SIZE + 4, true);
  if (barCount < 0 || nodeCount < 0) return null;
  if (sword2WalkGridBytes(barCount, nodeCount) > bytes.length) return null;

  const barsAt = RES_HEADER_SIZE + 8;
  return {
    bars: readSwordWalkBars(view, barsAt, barCount, true),
    nodes: readSwordWalkNodes(view, barsAt + barCount * SWORD_BAR_BYTES, nodeCount, true),
  };
}

/**
 * Writes a grid resource back, given the 44-byte header it came with.
 *
 * The header carries the resource's type and its name — `grid11`, `walkgrid128`
 * — and the name is what the surface calls the grid, so it is preserved whole
 * rather than rebuilt.
 */
export function writeSword2WalkGrid(grid: Sword2WalkGrid, header: Uint8Array): Uint8Array {
  const out = new Uint8Array(sword2WalkGridBytes(grid.bars.length, grid.nodes.length));
  out.set(header.subarray(0, Math.min(header.length, RES_HEADER_SIZE)));
  const view = new DataView(out.buffer);
  view.setInt32(RES_HEADER_SIZE, grid.bars.length, true);
  view.setInt32(RES_HEADER_SIZE + 4, grid.nodes.length, true);

  const barsAt = RES_HEADER_SIZE + 8;
  writeSwordWalkBars(view, barsAt, grid.bars, true);
  writeSwordWalkNodes(view, barsAt + grid.bars.length * SWORD_BAR_BYTES, grid.nodes, true);
  return out;
}
