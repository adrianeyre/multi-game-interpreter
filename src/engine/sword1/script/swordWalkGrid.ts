/**
 * A Broken Sword walk grid: the bars a mega may not cross and the nodes it
 * routes between.
 *
 * `SwordRouter` and `Sword2Router` both read one of these at the start of every
 * route, straight out of the resource and into fixed arrays sized by
 * `O_GRID_SIZE`. That is the right shape for a router and the wrong one for an
 * editor, which needs the same arithmetic in **both** directions: take a grid
 * apart so an author can see and move it, and put it back together as the bytes
 * the game shipped. So the reading lives here and the routers read through it,
 * for the reason `swordMask.ts` gives about mask grids — two readings of one
 * format drift, and the one that drifts is always the one nobody runs.
 *
 * ## A bar is a segment and seven numbers that follow from it
 *
 * The resource stores eleven fields per bar and only four of them are
 * independent. `dx` and `dy` are `x2 - x1` and `y2 - y1`; `xmin`, `ymin`,
 * `xmax` and `ymax` are the segment's bounding box; and `co` is
 * `y1 * dx - x1 * dy`, the line's constant term in the cross-product form
 * `lineCheck` solves. Revolution's grid compiler wrote all eleven; this writes
 * the four and derives the seven, which is what makes an edited bar a *bar*
 * rather than eleven numbers an author has to keep consistent by hand.
 *
 * That derivation is a claim about the shipped data and it is measured rather
 * than assumed: `npm run sweep:sword` re-emits every grid in an install from
 * its four-field form and compares. On the two demos it is 9 of 9 (Broken
 * Sword) and 4 of 4 (Broken Sword II) byte-identical.
 *
 * ## Why the bar and node codec is here and Sword II imports it
 *
 * ADR 0036's amendment states the rule: **a widget or a codec may cross; a
 * record may not.** The 24-byte bar and the 4-byte node are one codec that
 * Revolution carried forward unchanged between the two engines — the same
 * fields in the same order at the same widths — exactly as they carried the
 * "Tony" compressor, which `sword2Encode.ts` already imports from
 * `swordEncode.ts`. What does *not* cross is the grid record around them: a
 * Sword 1 grid begins with a scale ramp the router ignores and a Sword 1
 * resource header, a Sword II grid begins with neither and a 44-byte one. Each
 * family parses its own container, in its own file.
 */

import { SWORD1_HEADER_SIZE } from '../resource/swordDefs.js';

/** Bytes per stored bar and per stored node. Both families, both the same. */
export const SWORD_BAR_BYTES = 24;
export const SWORD_NODE_BYTES = 4;

/** A bar, as an author sees it: two ends of a line nothing may cross. */
export interface SwordWalkBar {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** A node: a place the router may turn at. */
export interface SwordWalkNode {
  readonly x: number;
  readonly y: number;
}

/** A bar with the seven fields the routers actually test against filled in. */
export interface SwordWalkBarFields extends SwordWalkBar {
  readonly xmin: number;
  readonly ymin: number;
  readonly xmax: number;
  readonly ymax: number;
  readonly dx: number;
  readonly dy: number;
  readonly co: number;
}

/**
 * The seven derived fields of a bar.
 *
 * `co` is deliberately not clamped to sixteen bits: it is the one `int32` in
 * the record, and on a 640-wide screen `y1 * dx` reaches six figures.
 */
export function swordWalkBarFields(bar: SwordWalkBar): SwordWalkBarFields {
  const dx = bar.x2 - bar.x1;
  const dy = bar.y2 - bar.y1;
  return {
    ...bar,
    xmin: Math.min(bar.x1, bar.x2),
    ymin: Math.min(bar.y1, bar.y2),
    xmax: Math.max(bar.x1, bar.x2),
    ymax: Math.max(bar.y1, bar.y2),
    dx,
    dy,
    co: bar.y1 * dx - bar.x1 * dy,
  };
}

/**
 * Reads `count` bars with all eleven fields exactly as stored.
 *
 * What the routers use, and deliberately not the same call the editor makes.
 * The seven derived fields are *derivable* and that claim is measured — 9 of 9
 * grids on the Broken Sword demo and 4 of 4 on Broken Sword II's re-emit
 * byte-identically from the four — but a router that derived them would answer
 * differently from the shipped game anywhere a grid compiler had written
 * something the derivation does not reproduce. Reading is reading; deriving is
 * an edit, and it belongs on the writing side only.
 */
export function readSwordWalkBarFields(
  view: DataView,
  at: number,
  count: number,
  littleEndian: boolean,
): SwordWalkBarFields[] {
  const bars: SwordWalkBarFields[] = [];
  for (let bar = 0; bar < count; bar++) {
    const from = at + bar * SWORD_BAR_BYTES;
    bars.push({
      x1: view.getInt16(from, littleEndian),
      y1: view.getInt16(from + 2, littleEndian),
      x2: view.getInt16(from + 4, littleEndian),
      y2: view.getInt16(from + 6, littleEndian),
      xmin: view.getInt16(from + 8, littleEndian),
      ymin: view.getInt16(from + 10, littleEndian),
      xmax: view.getInt16(from + 12, littleEndian),
      ymax: view.getInt16(from + 14, littleEndian),
      dx: view.getInt16(from + 16, littleEndian),
      dy: view.getInt16(from + 18, littleEndian),
      co: view.getInt32(from + 20, littleEndian),
    });
  }
  return bars;
}

/** Reads `count` bars from `at` as segments. The derived fields are skipped. */
export function readSwordWalkBars(
  view: DataView,
  at: number,
  count: number,
  littleEndian: boolean,
): SwordWalkBar[] {
  const bars: SwordWalkBar[] = [];
  for (let bar = 0; bar < count; bar++) {
    const from = at + bar * SWORD_BAR_BYTES;
    bars.push({
      x1: view.getInt16(from, littleEndian),
      y1: view.getInt16(from + 2, littleEndian),
      x2: view.getInt16(from + 4, littleEndian),
      y2: view.getInt16(from + 6, littleEndian),
    });
  }
  return bars;
}

/** Writes bars back, deriving the seven fields the grid compiler wrote. */
export function writeSwordWalkBars(
  view: DataView,
  at: number,
  bars: readonly SwordWalkBar[],
  littleEndian: boolean,
): void {
  bars.forEach((bar, index) => {
    const full = swordWalkBarFields(bar);
    const from = at + index * SWORD_BAR_BYTES;
    view.setInt16(from, full.x1, littleEndian);
    view.setInt16(from + 2, full.y1, littleEndian);
    view.setInt16(from + 4, full.x2, littleEndian);
    view.setInt16(from + 6, full.y2, littleEndian);
    view.setInt16(from + 8, full.xmin, littleEndian);
    view.setInt16(from + 10, full.ymin, littleEndian);
    view.setInt16(from + 12, full.xmax, littleEndian);
    view.setInt16(from + 14, full.ymax, littleEndian);
    view.setInt16(from + 16, full.dx, littleEndian);
    view.setInt16(from + 18, full.dy, littleEndian);
    view.setInt32(from + 20, full.co, littleEndian);
  });
}

export function readSwordWalkNodes(
  view: DataView,
  at: number,
  count: number,
  littleEndian: boolean,
): SwordWalkNode[] {
  const nodes: SwordWalkNode[] = [];
  for (let node = 0; node < count; node++) {
    const from = at + node * SWORD_NODE_BYTES;
    nodes.push({ x: view.getInt16(from, littleEndian), y: view.getInt16(from + 2, littleEndian) });
  }
  return nodes;
}

export function writeSwordWalkNodes(
  view: DataView,
  at: number,
  nodes: readonly SwordWalkNode[],
  littleEndian: boolean,
): void {
  nodes.forEach((node, index) => {
    const from = at + index * SWORD_NODE_BYTES;
    view.setInt16(from, node.x, littleEndian);
    view.setInt16(from + 2, node.y, littleEndian);
  });
}

/**
 * Where a Sword 1 grid's counts are: past the resource header and the scale
 * ramp.
 *
 * `scaleA` and `scaleB` sit in front of the counts and the router does not use
 * them — it takes the mega's own ramp instead — but they are the resource's
 * bytes and are carried rather than zeroed.
 */
export const SWORD1_WALK_GRID_COUNTS_AT = SWORD1_HEADER_SIZE + 8;

/** One Broken Sword walk grid resource, taken apart. */
export interface Sword1WalkGrid {
  readonly scaleA: number;
  readonly scaleB: number;
  readonly bars: readonly SwordWalkBar[];
  readonly nodes: readonly SwordWalkNode[];
}

/** How long a Sword 1 grid resource with these counts is. */
export function sword1WalkGridBytes(bars: number, nodes: number): number {
  return SWORD1_WALK_GRID_COUNTS_AT + 8 + bars * SWORD_BAR_BYTES + nodes * SWORD_NODE_BYTES;
}

/**
 * Reads a grid resource, or null when the bytes are not one.
 *
 * Null rather than a throw for the reason every reader here gives: a demo
 * install holds a floor object whose grid is on the other disc, and that is an
 * ordinary state rather than a fault.
 */
export function parseSword1WalkGrid(bytes: Uint8Array, bigEndian = false): Sword1WalkGrid | null {
  if (bytes.length < SWORD1_WALK_GRID_COUNTS_AT + 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = !bigEndian;
  const scaleA = view.getInt32(SWORD1_HEADER_SIZE, little);
  const scaleB = view.getInt32(SWORD1_HEADER_SIZE + 4, little);
  const barCount = view.getInt32(SWORD1_WALK_GRID_COUNTS_AT, little);
  const nodeCount = view.getInt32(SWORD1_WALK_GRID_COUNTS_AT + 4, little);
  if (barCount < 0 || nodeCount < 0) return null;
  if (sword1WalkGridBytes(barCount, nodeCount) > bytes.length) return null;

  const barsAt = SWORD1_WALK_GRID_COUNTS_AT + 8;
  return {
    scaleA,
    scaleB,
    bars: readSwordWalkBars(view, barsAt, barCount, little),
    nodes: readSwordWalkNodes(view, barsAt + barCount * SWORD_BAR_BYTES, nodeCount, little),
  };
}

/**
 * Writes a grid resource back, given the 20-byte header it came with.
 *
 * The header is carried rather than rebuilt because it names the resource's
 * type, version and compression, none of which this project has any business
 * inventing. Its two length words are corrected, because a grid that lost a bar
 * is shorter than the one that arrived.
 */
export function writeSword1WalkGrid(
  grid: Sword1WalkGrid,
  header: Uint8Array,
  bigEndian = false,
): Uint8Array {
  const little = !bigEndian;
  const out = new Uint8Array(sword1WalkGridBytes(grid.bars.length, grid.nodes.length));
  out.set(header.subarray(0, Math.min(header.length, SWORD1_HEADER_SIZE)));
  const view = new DataView(out.buffer);
  // Both lengths, because a grid that lost a bar is shorter than the one that
  // arrived: `compLength` at 8 is the whole resource and `decompLength` at 16
  // is the payload after the header. Every other word is the header's to keep.
  view.setUint32(8, out.length, little);
  view.setUint32(16, out.length - SWORD1_HEADER_SIZE, little);
  view.setInt32(SWORD1_HEADER_SIZE, grid.scaleA, little);
  view.setInt32(SWORD1_HEADER_SIZE + 4, grid.scaleB, little);
  view.setInt32(SWORD1_WALK_GRID_COUNTS_AT, grid.bars.length, little);
  view.setInt32(SWORD1_WALK_GRID_COUNTS_AT + 4, grid.nodes.length, little);

  const barsAt = SWORD1_WALK_GRID_COUNTS_AT + 8;
  writeSwordWalkBars(view, barsAt, grid.bars, little);
  writeSwordWalkNodes(view, barsAt + grid.bars.length * SWORD_BAR_BYTES, grid.nodes, little);
  return out;
}
