import { describe, expect, it } from 'vitest';
import { decompressIcon, drawSimon2Icon, SIMON2_ICON_WIDTH } from '../src/engine/agos/gfx/icons.js';

/**
 * Pins `decompressIcon`'s two branches and its column-major direction against
 * the reference (`icons.cpp:150`), then checks it round-trips a bitmap it
 * encoded itself.
 *
 * The RLE is transcribed control-flow, so the danger is a plausible-but-wrong
 * decode — a run that produces the right *number* of pixels in the wrong order
 * or colour. Hand-built streams with known output catch that where a
 * screenshot could not: 20 lit pixels in the band look the same whether or not
 * they are the right 20.
 */
describe('decompressIcon', () => {
  it('lays a literal run down the column, two pixels per byte', () => {
    // width=1 column, height=2 → a 4-pixel-tall column. reps=1 runs the
    // literal loop twice (`--reps >= 0`), so two bytes = four pixels.
    const pitch = 20;
    const dst = new Uint8Array(pitch * 4);
    // reps=1, then 0x12 and 0x34 — nibbles 1,2,3,4 ORed with base 224.
    const src = new Uint8Array([1, 0x12, 0x34]);
    decompressIcon(dst, 0, src, 0, 1, 2, 224, pitch);

    expect(dst[0]).toBe(1 | 224);
    expect(dst[pitch]).toBe(2 | 224);
    expect(dst[pitch * 2]).toBe(3 | 224);
    expect(dst[pitch * 3]).toBe(4 | 224);
  });

  it('repeats one nibble-pair for the negative branch', () => {
    // reps=-2 (0xFE) → after `reps--` the do/while (`++reps != 0`) runs three
    // times, so one colour byte fills a 6-pixel column.
    const pitch = 20;
    const dst = new Uint8Array(pitch * 6);
    const src = new Uint8Array([0xfe, 0x56]);
    decompressIcon(dst, 0, src, 0, 1, 3, 224, pitch);

    for (let row = 0; row < 6; row += 1) {
      expect(dst[pitch * row]).toBe((row % 2 === 0 ? 5 : 6) | 224);
    }
  });

  it('treats a zero nibble as transparent', () => {
    const pitch = 20;
    const dst = new Uint8Array(pitch * 2).fill(99);
    // 0x05: high nibble 0 leaves the first pixel, low nibble 5 sets the second.
    const src = new Uint8Array([0, 0x05]);
    decompressIcon(dst, 0, src, 0, 1, 1, 224, pitch);

    expect(dst[0]).toBe(99); // untouched
    expect(dst[pitch]).toBe(5 | 224);
  });

  it('steps to the next column once a column is full', () => {
    // width=2, height=1 → two columns, each two pixels tall. dst_org advances
    // by one after the first column, so column 1 lands at offset 1.
    const pitch = 20;
    const dst = new Uint8Array(pitch * 2);
    // Two literal runs of one byte each (reps=0 → one iteration).
    const src = new Uint8Array([0, 0x12, 0, 0x34]);
    decompressIcon(dst, 0, src, 0, 2, 1, 224, pitch);

    expect(dst[0]).toBe(1 | 224); // column 0, row 0
    expect(dst[pitch]).toBe(2 | 224); // column 0, row 1
    expect(dst[1]).toBe(3 | 224); // column 1, row 0
    expect(dst[1 + pitch]).toBe(4 | 224); // column 1, row 1
  });

  it('round-trips a bitmap through a literal encoding of itself', () => {
    // Encode a known cell as one literal run per column (reps = height-1), then
    // decode and compare. "Tested against its own output": the decoder is the
    // inverse of this deliberately trivial encoder.
    const width = SIMON2_ICON_WIDTH;
    const height = 10; // 20 pixels tall
    const pitch = 64;
    const base = 224;

    // A source cell: colours are 1..15 so every nibble is non-zero (no
    // transparency to muddy the comparison), varying by position.
    const cell: number[][] = [];
    for (let py = 0; py < height * 2; py += 1) {
      const rowArr: number[] = [];
      for (let px = 0; px < width; px += 1) rowArr.push(((px + py) % 15) + 1);
      cell.push(rowArr);
    }

    // Encode column-major: for each column, reps = height-1 then `height`
    // bytes, each a nibble-pair of two stacked pixels.
    const stream: number[] = [];
    for (let col = 0; col < width; col += 1) {
      stream.push(height - 1);
      for (let pair = 0; pair < height; pair += 1) {
        const hi = cell[pair * 2]![col]!;
        const lo = cell[pair * 2 + 1]![col]!;
        stream.push((hi << 4) | lo);
      }
    }

    const dst = new Uint8Array(pitch * height * 2);
    decompressIcon(dst, 0, new Uint8Array(stream), 0, width, height, base, pitch);

    for (let py = 0; py < height * 2; py += 1) {
      for (let px = 0; px < width; px += 1) {
        expect(dst[py * pitch + px]).toBe(cell[py]![px]! | base);
      }
    }
  });
});

/**
 * `drawSimon2Icon` reads the four-byte table entry and runs both colour passes
 * into the framebuffer at the `110 + x + (y + windowY) * pitch` origin the
 * reference fixes (`icons.cpp:209`).
 */
describe('drawSimon2Icon', () => {
  it('draws both passes at the 110-pixel margin', () => {
    const pitch = 320;
    const dst = new Uint8Array(pitch * 200);

    // A tiny icon file: a 4-byte offset table for icon 0, then two streams.
    // Pass one (base 224) writes a single pixel, pass two (base 208) another.
    const table = [8, 0, 0, 0]; // both passes start at offset... set below
    // Lay out: table (4 bytes) then stream A at 4, stream B at 8.
    const streamA = [0, 0x10]; // literal: hi nibble 1 → 1|224 at origin
    const streamB = [0, 0x20]; // literal: hi nibble 2 → 2|208 at origin
    table[0] = 4; // pass one offset
    table[1] = 0;
    table[2] = 4 + streamA.length; // pass two offset
    table[3] = 0;
    const iconFile = new Uint8Array([...table, ...streamA, ...streamB]);

    const x = 0;
    const y = 0;
    const windowY = 152;
    drawSimon2Icon(dst, iconFile, 0, x, y, windowY, pitch);

    const origin = 110 + x + (y + windowY) * pitch;
    // Pass two runs last, so base 208 is what survives at the origin pixel.
    expect(dst[origin]).toBe(2 | 208);
  });

  it('ignores an icon number past the table', () => {
    const dst = new Uint8Array(320 * 200);
    const iconFile = new Uint8Array([0, 0, 0, 0]);
    expect(() => drawSimon2Icon(dst, iconFile, 99, 0, 0, 152, 320)).not.toThrow();
  });
});
