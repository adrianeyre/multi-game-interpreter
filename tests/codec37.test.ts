import { describe, expect, it } from 'vitest';
import { Codec37Decoder } from '../src/engine/video/codec37.js';

/** A codec 37 frame header: kind, table page, sequence, decoded size, flags. */
function frame(
  kind: number,
  { page = 0, seq = 0, decodedSize = 0, flags = 0 } = {},
  payload: number[] = [],
): Uint8Array {
  const header = new Uint8Array(16);
  header[0] = kind;
  header[1] = page;
  new DataView(header.buffer).setUint16(2, seq, true);
  new DataView(header.buffer).setUint32(4, decodedSize, true);
  header[12] = flags;
  return new Uint8Array([...header, ...payload]);
}

/**
 * SMUSH codec 37.
 *
 * Motion-compensated 4x4 blocks over two frame buffers, so decoding frame *n*
 * requires every frame before it. These are Tier 1 only: they prove the
 * decoder's framing and its own arithmetic, and cannot prove the reading is
 * right. A wrong motion table produces a picture built from the right blocks in
 * the wrong places — recognisably the right scene, visibly wrong, and invisible
 * to any fixture written from the same reading. **#101 should not close on
 * these; it should close on a demo's own `.SAN`.**
 */
describe('codec 37', () => {
  it('takes a whole keyframe as it is', () => {
    const decoder = new Codec37Decoder(4, 4);
    const pixels = Array.from({ length: 16 }, (_, i) => i + 1);
    const out = new Uint8Array(16);

    expect(decoder.decode(frame(0, { decodedSize: 16 }, pixels), out)).toBe(true);
    expect([...out]).toEqual(pixels);
  });

  it('clears the rest of the buffer, so an old frame does not show through', () => {
    const decoder = new Codec37Decoder(4, 4);
    const out = new Uint8Array(16);

    decoder.decode(frame(0, { decodedSize: 16 }, new Array(16).fill(9)), out);
    decoder.decode(frame(0, { decodedSize: 4 }, [1, 2, 3, 4]), out);

    expect([...out.subarray(0, 4)]).toEqual([1, 2, 3, 4]);
    expect([...out.subarray(4)]).toEqual(new Array(12).fill(0));
  });

  it('writes sixteen literal pixels for the 0xFF escape', () => {
    const decoder = new Codec37Decoder(4, 4);
    const out = new Uint8Array(16);
    const literals = Array.from({ length: 16 }, (_, i) => i + 1);

    expect(decoder.decode(frame(3, {}, [0xff, ...literals]), out)).toBe(true);
    expect([...out]).toEqual(literals);
  });

  it('fills a block with one colour for the 0xFD escape', () => {
    const decoder = new Codec37Decoder(4, 4);
    const out = new Uint8Array(16);

    // Flag 4 is what enables the 0xFD/0xFE escapes.
    expect(decoder.decode(frame(3, { flags: 4 }, [0xfd, 7]), out)).toBe(true);
    expect([...out]).toEqual(new Array(16).fill(7));
  });

  it('writes a colour per row for the 0xFE escape', () => {
    const decoder = new Codec37Decoder(4, 4);
    const out = new Uint8Array(16);

    decoder.decode(frame(3, { flags: 4 }, [0xfe, 1, 2, 3, 4]), out);
    expect([...out.subarray(0, 4)]).toEqual([1, 1, 1, 1]);
    expect([...out.subarray(12)]).toEqual([4, 4, 4, 4]);
  });

  it('does not treat 0xFD as an escape when the frame does not enable it', () => {
    // Without flag 4, 0xFD is a motion vector like any other code. Reading it
    // as an escape consumes a byte that belongs to the next block and
    // desynchronises the rest of the frame.
    const decoder = new Codec37Decoder(4, 4);
    const out = new Uint8Array(16);

    expect(decoder.decode(frame(3, { flags: 0 }, [0xfd, 7]), out)).toBe(true);
  });

  it('repeats unchanged blocks for sub-codec 4’s run', () => {
    // The 0x00 run is what makes a still scene nearly free: "this many blocks
    // are as they were in the last frame".
    const decoder = new Codec37Decoder(8, 4);
    const out = new Uint8Array(32);

    decoder.decode(frame(0, { decodedSize: 32 }, new Array(32).fill(5)), out);
    expect(decoder.decode(frame(4, { seq: 1, flags: 1 }, [0x00, 1]), out)).toBe(true);
  });

  it('decodes a run-length frame for sub-codec 2', () => {
    const decoder = new Codec37Decoder(4, 4);
    const out = new Uint8Array(16);

    // A run of sixteen 6s: ((16-1) << 1) | 1 = 31.
    expect(decoder.decode(frame(2, { decodedSize: 16 }, [31, 6]), out)).toBe(true);
    expect([...out]).toEqual(new Array(16).fill(6));
  });

  it('reports an unknown sub-codec rather than leaving the last frame up', () => {
    // A stalled video is much harder to diagnose than a named number.
    const decoder = new Codec37Decoder(4, 4);
    expect(decoder.decode(frame(9), new Uint8Array(16))).toBe(false);
  });

  it('refuses a frame too short to hold a header', () => {
    const decoder = new Codec37Decoder(4, 4);
    expect(decoder.decode(new Uint8Array(4), new Uint8Array(16))).toBe(false);
  });

  it('survives a truncated payload instead of running off the end', () => {
    const decoder = new Codec37Decoder(8, 8);
    const out = new Uint8Array(64);
    expect(() => decoder.decode(frame(3, {}, [0xff, 1, 2]), out)).not.toThrow();
  });
});
