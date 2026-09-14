/**
 * A room as one image: the backdrop with everything drawn on it.
 *
 * **`docs/editor-parity.md` row 16 answered Yes for five kinds of artwork and
 * not for the one an author most wants out.** A View's cels come out one at a
 * time and a Picture comes out bare, so the thing actually on screen — the
 * place, with its cast standing in it — was the only view of the game that
 * could be looked at and not saved. Reported as "I don't have the ability to
 * save rooms, objects, player or actor images".
 *
 * Composited in the Picture's own pixels rather than the canvas's, so the file
 * is the artwork's size whatever the pane is zoomed to, and through
 * `pieceBounds` — the same placement the canvas draws with, called rather than
 * copied, so an export cannot drift from what was on screen.
 */

import { describe, expect, it } from 'vitest';

import { sciRoomImage } from '../src/editor/sci/SciRoomCanvas.js';
import type { SciRoomPiece } from '../src/editor/sci/SciRoomCanvas.js';

/** A flat image of one colour, opaque unless `alpha` says otherwise. */
function image(width: number, height: number, rgb: [number, number, number], alpha = 255) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = rgb[0];
    rgba[i * 4 + 1] = rgb[1];
    rgba[i * 4 + 2] = rgb[2];
    rgba[i * 4 + 3] = alpha;
  }
  return { width, height, rgba };
}

function piece(over: Partial<SciRoomPiece> & { x: number; y: number }): SciRoomPiece {
  const { x, y, ...rest } = over;
  return {
    thing: { objectIndex: 0, name: 'thing', x, y, xProperty: 0, yProperty: 0, view: 0, loop: 0 },
    cel: {
      width: 4,
      height: 4,
      displaceX: 0,
      displaceY: 0,
      clearKey: 255,
      pixels: new Uint8Array(16),
    },
    image: image(4, 4, [255, 0, 0]),
    why: null,
    ...rest,
  } as SciRoomPiece;
}

/** The pixel at `x, y`, as four numbers. */
function at(rendered: { width: number; rgba: Uint8ClampedArray }, x: number, y: number): number[] {
  const i = (y * rendered.width + x) * 4;
  return [rendered.rgba[i], rendered.rgba[i + 1], rendered.rgba[i + 2], rendered.rgba[i + 3]];
}

describe('a room exports as the picture it is', () => {
  it('is the backdrop when nothing is on it', () => {
    const backdrop = image(320, 200, [10, 20, 30]);
    const rendered = sciRoomImage(backdrop, []);
    expect(rendered).toMatchObject({ width: 320, height: 200 });
    expect(at(rendered!, 5, 5)).toEqual([10, 20, 30, 255]);
  });

  it('draws a thing over the backdrop where the thing is', () => {
    const backdrop = image(320, 200, [10, 20, 30]);
    const rendered = sciRoomImage(backdrop, [piece({ x: 100, y: 50 })])!;
    expect(at(rendered, 100, 50)).toEqual([255, 0, 0, 255]);
    // And leaves the rest of the room alone.
    expect(at(rendered, 5, 5)).toEqual([10, 20, 30, 255]);
  });

  /** A cel's clear key is transparency, and transparency is not black. */
  it('leaves the backdrop showing through a transparent pixel', () => {
    const backdrop = image(320, 200, [10, 20, 30]);
    const clear = piece({ x: 100, y: 50 });
    const rendered = sciRoomImage(backdrop, [{ ...clear, image: image(4, 4, [255, 0, 0], 0) }])!;
    expect(at(rendered, 100, 50)).toEqual([10, 20, 30, 255]);
  });

  /** A thing with no art is skipped rather than drawn as a hole. */
  it('skips a thing this release has no art for', () => {
    const backdrop = image(320, 200, [10, 20, 30]);
    const rendered = sciRoomImage(backdrop, [
      { ...piece({ x: 100, y: 50 }), image: null, why: 'no View' },
    ])!;
    expect(at(rendered, 100, 50)).toEqual([10, 20, 30, 255]);
  });

  /** Off the edge is clipped, not wrapped onto the other side. */
  it('clips a thing that hangs off the room rather than wrapping it', () => {
    const backdrop = image(320, 200, [10, 20, 30]);
    const rendered = sciRoomImage(backdrop, [piece({ x: 318, y: 50 })])!;
    expect(at(rendered, 0, 50)).toEqual([10, 20, 30, 255]);
    expect(at(rendered, 319, 50)).toEqual([255, 0, 0, 255]);
  });

  it('has nothing to answer with when there is no backdrop and no art', () => {
    expect(sciRoomImage(null, [])).toBeNull();
  });
});
