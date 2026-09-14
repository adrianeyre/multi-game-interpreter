import { describe, expect, it } from 'vitest';
import { decodeMaskStrip, decodeStrip, isTransparentCodec } from '../src/engine/gfx/BitmapCodec.js';
import { Palette } from '../src/engine/gfx/Palette.js';
import { Screen } from '../src/engine/gfx/Screen.js';
import { RoomGraphics } from '../src/engine/gfx/RoomGraphics.js';
import { Charset, wrapText, layoutSpeech } from '../src/engine/gfx/Charset.js';
import { buildCharsetPayload, chunk, u32le } from './fixture.js';

/** A codec 1 strip: raw 8-bit pixels, all one colour. */
function rawStrip(height: number, color: number): number[] {
  return [1, ...new Array(8 * height).fill(color)];
}

describe('bitmap codecs', () => {
  it('decodes raw pixels (codec 1)', () => {
    const height = 3;
    const src = new Uint8Array([1, ...Array.from({ length: 8 * height }, (_, i) => i)]);
    const dst = new Uint8Array(8 * height);

    decodeStrip(src, 0, {
      dst,
      dstOffset: 0,
      dstStride: 8,
      height,
      transparentColor: 255,
    });

    expect([...dst.slice(0, 8)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect([...dst.slice(16, 24)]).toEqual([16, 17, 18, 19, 20, 21, 22, 23]);
  });

  it('leaves the destination untouched for transparent pixels (codec 149)', () => {
    const height = 1;
    const src = new Uint8Array([149, 255, 5, 255, 5, 255, 5, 255, 5]);
    const dst = new Uint8Array(8).fill(99);

    decodeStrip(src, 0, {
      dst,
      dstOffset: 0,
      dstStride: 8,
      height,
      transparentColor: 255,
    });

    expect([...dst]).toEqual([99, 5, 99, 5, 99, 5, 99, 5]);
  });

  it('classifies which codecs honour the transparent colour', () => {
    expect(isTransparentCodec(1)).toBe(false);
    expect(isTransparentCodec(149)).toBe(true);
    expect(isTransparentCodec(14)).toBe(false);
    expect(isTransparentCodec(34)).toBe(true);
    expect(isTransparentCodec(68)).toBe(false);
    expect(isTransparentCodec(88)).toBe(true);
    expect(isTransparentCodec(138)).toBe(false);
    expect(isTransparentCodec(148)).toBe(true);
  });

  it('decodes a vertical zigzag strip without running off the buffer', () => {
    // Codec 14: 4 bits per literal, vertical scan. A stream of zero bits means
    // "keep the current colour", so the whole strip should be one colour.
    const height = 4;
    const src = new Uint8Array([14, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const dst = new Uint8Array(8 * height);

    decodeStrip(src, 0, {
      dst,
      dstOffset: 0,
      dstStride: 8,
      height,
      transparentColor: 255,
    });

    expect([...dst]).toEqual(new Array(8 * height).fill(7));
  });

  it('expands a run-length encoded mask strip', () => {
    // 0x80 | 4 means "repeat the next byte four times".
    const src = new Uint8Array([0x84, 0b10101010]);
    const dst = new Uint8Array(4);
    decodeMaskStrip(src, 0, dst, 0, 1, 4);
    expect([...dst]).toEqual([0xaa, 0xaa, 0xaa, 0xaa]);
  });

  it('expands a literal mask run', () => {
    const src = new Uint8Array([3, 0x01, 0x02, 0x03]);
    const dst = new Uint8Array(3);
    decodeMaskStrip(src, 0, dst, 0, 1, 3);
    expect([...dst]).toEqual([1, 2, 3]);
  });

  it('terminates on a zero run length instead of spinning', () => {
    // A zero run consumes no rows, so a `while` loop would never advance and
    // the page would hang. Each run must consume at least one row.
    const src = new Uint8Array([0x80, 0xff, 0x00, 0x00, 0x00]);
    const dst = new Uint8Array(4);
    decodeMaskStrip(src, 0, dst, 0, 1, 4);
    expect(dst.length).toBe(4);
  });

  it('terminates when the mask data runs out before the rows do', () => {
    // A truncated plane used to read `undefined` forever: the run length came
    // back undefined, matched neither branch's loop condition, and the outer
    // loop never made progress.
    const src = new Uint8Array([3, 0x01]);
    const dst = new Uint8Array(200);
    decodeMaskStrip(src, 0, dst, 0, 1, 200);
    expect(dst[0]).toBe(1);
  });

  it('stops a mask run at the requested height', () => {
    const src = new Uint8Array([0xff, 0x0f]);
    const dst = new Uint8Array(2);
    decodeMaskStrip(src, 0, dst, 0, 1, 2);
    expect([...dst]).toEqual([0x0f, 0x0f]);
  });
});

describe('palette', () => {
  it('scales 6 bit VGA palettes up to 8 bit', () => {
    const palette = new Palette();
    const clut = new Uint8Array(256 * 3);
    clut[0] = 63;
    clut[1] = 32;
    clut[2] = 0;
    palette.setFromClut(clut);
    palette.normaliseDepth();
    palette.flush();

    expect(palette.rgba[0]).toBe(255);
    expect(palette.rgba[1]).toBeGreaterThan(120);
    expect(palette.rgba[2]).toBe(0);
  });

  it('leaves an 8 bit palette alone', () => {
    const palette = new Palette();
    const clut = new Uint8Array(256 * 3);
    clut[0] = 200;
    palette.setFromClut(clut);
    palette.normaliseDepth();
    palette.flush();
    expect(palette.rgba[0]).toBe(200);
  });

  it('rotates a cycling range once the delay elapses', () => {
    const palette = new Palette();
    const clut = new Uint8Array(256 * 3);
    for (let i = 0; i < 4; i++) clut[i * 3] = i * 10;
    palette.setFromClut(clut);
    palette.setCycles([{ start: 0, end: 3, delay: 1, direction: 1, counter: 0 }]);

    palette.step();
    const [red] = palette.getColor(1);
    expect(red).toBe(0); // entry 0 rotated into position 1
  });

  it('does not cycle when the delay is zero', () => {
    const palette = new Palette();
    const clut = new Uint8Array(256 * 3);
    for (let i = 0; i < 4; i++) clut[i * 3] = i * 10;
    palette.setFromClut(clut);
    palette.setCycles([{ start: 0, end: 3, delay: 0, direction: 1, counter: 0 }]);
    palette.step();
    expect(palette.getColor(1)[0]).toBe(10);
  });
});

describe('screen', () => {
  it('splits the display into text, room and verb bands', () => {
    const screen = new Screen();
    screen.setLayout(16, 144);
    expect(screen.text).toEqual({ top: 0, height: 16 });
    expect(screen.main).toEqual({ top: 16, height: 128 });
    expect(screen.verb).toEqual({ top: 144, height: 56 });
  });

  it('clips writes outside the framebuffer', () => {
    const screen = new Screen();
    screen.putPixel(-1, 0, 5);
    screen.putPixel(0, -1, 5);
    screen.putPixel(320, 0, 5);
    expect(screen.pixels.every((value) => value === 0)).toBe(true);
  });

  it('scrolls the room by the camera position', () => {
    const screen = new Screen();
    screen.setLayout(0, 200);
    const room = new RoomGraphics(640, 200, 0);
    for (let x = 0; x < 640; x++) room.background[x] = x & 0xff;

    screen.drawRoom(room, 100);
    expect(screen.getPixel(0, 0)).toBe(100);
    expect(screen.getPixel(10, 0)).toBe(110);
  });

  it('clamps the camera to the room width', () => {
    const screen = new Screen();
    screen.setLayout(0, 200);
    const room = new RoomGraphics(320, 200, 0);
    room.background[0] = 42;
    screen.drawRoom(room, 500);
    expect(screen.getPixel(0, 0)).toBe(42);
  });
});

describe('an object image drawn over the room', () => {
  /**
   * Half the codec family is *transparent*: those decoders skip a pixel rather
   * than writing one, and "skip" has to mean "keep what was already there".
   * Decoded into a fresh buffer and then blitted whole, every skipped pixel
   * arrives as colour 0 and is stamped over the background — which is how
   * Atlantis's title card, an object whose image is a few words on transparent
   * pixels, drew as a black rectangle with the words inside it.
   */
  function transparentImage(color: number): Uint8Array {
    const height = 2;
    // Codec 149: raw bytes, with `transparentColor` meaning "leave it".
    const strip = [149];
    for (let row = 0; row < height; row++) {
      for (let x = 0; x < 8; x++) strip.push(x === 0 ? color : 255);
    }
    const smap = chunk('SMAP', [...u32le(8 + 4), ...strip]);
    return new Uint8Array(chunk('IM01', smap));
  }

  it('keeps the background where the codec says transparent', () => {
    const room = new RoomGraphics(320, 200, 0, 255);
    room.background.fill(7);

    room.decodeImage(transparentImage(3), 0, 0, 0, 8, 2, false);

    expect(room.background[0]).toBe(3); // the drawn pixel
    expect(room.background[1]).toBe(7); // transparent: the room shows through
    expect(room.background[321]).toBe(7); // and on the second row too
  });

  it('still paints every pixel for an opaque codec', () => {
    const room = new RoomGraphics(320, 200, 0, 255);
    room.background.fill(7);

    const image = new Uint8Array(chunk('IM01', chunk('SMAP', [...u32le(12), ...rawStrip(2, 4)])));
    room.decodeImage(image, 0, 0, 0, 8, 2, false);

    expect(room.background[0]).toBe(4);
    expect(room.background[1]).toBe(4);
  });
});

describe('room graphics masks', () => {
  it('reports a pixel as masked when its z-plane bit is set', () => {
    const room = new RoomGraphics(320, 144, 1);
    // Strip 2, row 5, leftmost pixel of the byte.
    room.zPlanes[0][5 * room.strips + 2] = 0x80;
    expect(room.isMasked(1, 16, 5)).toBe(true);
    expect(room.isMasked(1, 17, 5)).toBe(false);
    expect(room.isMasked(0, 16, 5)).toBe(false);
  });

  /**
   * An actor is drawn against the one mask its walk box names, not against
   * that plane and everything above it. Testing the higher planes too makes a
   * room's foreground layers occlude an actor standing in front of them —
   * Indy walks past a doorway and the wall beside it draws over him.
   */
  it('tests only the plane it is asked about', () => {
    const room = new RoomGraphics(320, 144, 2);
    room.zPlanes[1][5 * room.strips + 2] = 0x80; // set in plane 2 alone

    expect(room.isMasked(2, 16, 5)).toBe(true);
    expect(room.isMasked(1, 16, 5)).toBe(false);
  });

  it('masks against nothing when the plane is past the ones the room has', () => {
    const room = new RoomGraphics(320, 144, 1);
    room.zPlanes[0][5 * room.strips + 2] = 0x80;

    expect(room.isMasked(3, 16, 5)).toBe(false);
  });
});

describe('charset', () => {
  const charset = new Charset(0, new Uint8Array(chunk('CHAR', buildCharsetPayload())));

  it('reads the font header', () => {
    expect(charset.bitsPerPixel).toBe(1);
    expect(charset.fontHeight).toBe(8);
    expect(charset.numChars).toBe(128);
  });

  it('measures a defined glyph and ignores undefined ones', () => {
    expect(charset.getCharWidth('A'.charCodeAt(0))).toBe(8);
    expect(charset.getCharWidth('Z'.charCodeAt(0))).toBe(0);
    expect(charset.getStringWidth('AAA')).toBe(24);
  });

  it('draws a glyph into the framebuffer', () => {
    const screen = new Screen();
    charset.drawChar(screen, 'A'.charCodeAt(0), 0, 0, 9);
    // Row 0 of 'A' is 0b00011000.
    expect(screen.getPixel(3, 0)).toBe(9);
    expect(screen.getPixel(4, 0)).toBe(9);
    expect(screen.getPixel(0, 0)).toBe(0);
  });

  it('wraps text to the requested width', () => {
    const lines = wrapText(charset, 'AAA AAA AAA', 16);
    expect(lines).toEqual(['AAA', 'AAA', 'AAA']);
  });

  it('keeps explicit line breaks', () => {
    expect(wrapText(charset, 'AA\nAA', 1000)).toEqual(['AA', 'AA']);
  });

  it('keeps speech on screen when the speaker is at the edge', () => {
    const placed = layoutSpeech(charset, ['AAAA'], 2, 100, 0, 200);
    expect(placed[0].x).toBeGreaterThanOrEqual(0);
  });

  it('does not push speech above the text band', () => {
    const placed = layoutSpeech(charset, ['A', 'A', 'A'], 160, 4, 8, 200);
    expect(placed[0].y).toBeGreaterThanOrEqual(8);
  });
});
