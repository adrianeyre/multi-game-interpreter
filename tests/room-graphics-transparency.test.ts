import { describe, expect, it } from 'vitest';
import { RoomGraphics } from '../src/engine/gfx/RoomGraphics.js';
import { chunk, u32le } from './fixture.js';

/**
 * What a transparent codec means by "transparent".
 *
 * It says "leave this pixel alone" by *not writing* it, which only works if
 * whatever reads the result already holds what was there. Decoding into a
 * scratch buffer that starts at zero and then copying the buffer whole turns
 * every one of those pixels into colour 0 — so the room shows through as black
 * and every object in the game arrives inside a black rectangle. The pixels the
 * codec skips are exactly the pixels a test has to look at.
 */

const TRANSPARENT = 5;
const BACKGROUND = 42;
const PAINTED = 99;

/**
 * An 8-wide image in codec 149 — raw bytes, transparent — as one strip.
 *
 * Wrapped the way `decodeImage` reads one: an outer chunk holding an `SMAP`,
 * whose payload opens with a strip offset table counted from the `SMAP`'s own
 * first byte.
 */
function objectImage(rows: number[][]): Uint8Array {
  const strip = [149, ...rows.flat()];
  // The one table entry, then the strip: the header (8) plus the table (4).
  const smap = chunk('SMAP', [...u32le(8 + 4), ...strip]);
  return new Uint8Array(chunk('OBIM', smap));
}

describe('stamping an object image into the room', () => {
  it('leaves the background showing where the image is transparent', () => {
    const graphics = new RoomGraphics(16, 4, 0, TRANSPARENT);
    graphics.background.fill(BACKGROUND);

    // Row 0 is painted, row 1 is transparent throughout.
    const data = objectImage([
      [PAINTED, PAINTED, PAINTED, PAINTED, PAINTED, PAINTED, PAINTED, PAINTED],
      Array.from({ length: 8 }, () => TRANSPARENT),
    ]);

    graphics.decodeImage(data, 0, 0, 0, 8, 2, false);

    expect([...graphics.background.subarray(0, 8)]).toEqual(
      Array.from({ length: 8 }, () => PAINTED),
    );
    // The whole point: not zero.
    expect([...graphics.background.subarray(16, 24)]).toEqual(
      Array.from({ length: 8 }, () => BACKGROUND),
    );
  });

  it('keeps the background under a strip that hangs off the room', () => {
    const graphics = new RoomGraphics(16, 4, 0, TRANSPARENT);
    graphics.background.fill(BACKGROUND);

    const data = objectImage([
      Array.from({ length: 8 }, () => TRANSPARENT),
      Array.from({ length: 8 }, () => TRANSPARENT),
    ]);

    // Half of the strip is to the left of the room's first column.
    graphics.decodeImage(data, 0, -4, 0, 8, 2, false);

    expect([...graphics.background.subarray(0, 8)]).toEqual(
      Array.from({ length: 8 }, () => BACKGROUND),
    );
  });
});
