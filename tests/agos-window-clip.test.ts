import { describe, expect, it } from 'vitest';
import { VgaMachine, type VgaTarget } from '../src/engine/agos/gfx/VgaMachine.js';
import { VGA_OPCODE_TABLES } from '../src/engine/agos/gfx/vgaOpcodeTables.js';

/**
 * The window a draw is clipped to, and why Simon's interface survives a room.
 *
 * Simon's engine hardcodes five drawing windows (`_videoWindows`), and a room
 * is drawn into window 4 — the top 134 rows, the play area — so the picture
 * never reaches the interface band below it. The band holds the verb icons and
 * the inventory, drawn once into window 0; a room that clipped to the whole
 * screen instead painted straight over them.
 *
 * These tests pin that clip at the machine: with window 4 selected a
 * full-screen cel stops at row 134, and with window 0 (the whole screen) it
 * does not. The window x/width are in sixteens of pixels, y/height in pixels.
 */

const DRAW = VGA_OPCODE_TABLES.simon2!.findIndex((entry) => entry?.endsWith('|DRAW'));
const RET = 0;

/** The opaque flag: colour zero is drawn rather than left transparent. */
const DRAW_OPAQUE = 0x2;

/** A big-endian 32-bit word. */
function be32(value: number): number[] {
  return [(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/**
 * A pixel resource whose entry 1 is one opaque cel the size of the screen.
 *
 * Eight bytes an entry — a BE32 offset, a flags byte, a height byte and the
 * BE16 pixel width — then the cel's bytes at that offset. Every byte is two
 * pixels of colour five, so a painted pixel reads back as five and an unpainted
 * one keeps the target's sentinel.
 */
function fullScreenCel(): Uint8Array {
  const width = 320;
  const height = 200;
  const widthBytes = width / 2;
  const offset = 16; // two eight-byte entries precede the pixels
  const entry = [...be32(offset), DRAW_OPAQUE, height, (width >> 8) & 0xff, width & 0xff];
  const out = new Uint8Array(offset + widthBytes * height);
  out.set(entry, 8); // entry 1
  out.fill(0x55, offset); // colour five, both nibbles
  return out;
}

/** DRAW image 1, palette 0, at (0,0), opaque — then return. */
const SCRIPT = Uint8Array.from([DRAW, 0, 1, 0, 0, 0, 0, 0, 0, DRAW_OPAQUE, RET]);

function paintFullScreen(window: number): Uint8Array {
  const pixels = fullScreenCel();
  const windows = new Map<number, [number, number, number, number]>([
    [0, [0, 0, 20, 200]], // the whole screen
    [4, [0, 0, 20, 134]], // the play area: the top 134 rows
  ]);
  const target: VgaTarget = {
    width: 320,
    height: 200,
    pixels: new Uint8Array(320 * 200).fill(0x7f), // a sentinel, so an unpainted row shows
    windows,
  };
  const machine = new VgaMachine(SCRIPT, pixels, 'simon2', target);
  machine.drawWindow = window;
  machine.run(0);
  return target.pixels;
}

describe("a room is clipped to Simon's play-area window", () => {
  it('leaves the interface band below row 134 untouched when drawn into window 4', () => {
    const painted = paintFullScreen(4);

    // The play area is painted to its last row...
    expect(painted[0]).toBe(5);
    expect(painted[133 * 320]).toBe(5);
    // ...and the band below it keeps the sentinel: the verb icons and inventory
    // drawn there are not overpainted.
    expect(painted[134 * 320]).toBe(0x7f);
    expect(painted[199 * 320]).toBe(0x7f);
  });

  it('paints the whole screen when drawn into window 0, the bug the clip fixes', () => {
    const painted = paintFullScreen(0);

    // Without the play-area window the same cel reaches the band and covers it.
    expect(painted[0]).toBe(5);
    expect(painted[134 * 320]).toBe(5);
    expect(painted[199 * 320]).toBe(5);
  });
});
