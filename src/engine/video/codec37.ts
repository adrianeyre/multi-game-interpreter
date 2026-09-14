/**
 * SMUSH codec 37: motion-compensated four-by-four blocks.
 *
 * The frame is cut into 4x4 blocks and most of them are not encoded at all —
 * they are a *reference* to a block in one of two previous frames, displaced by
 * a motion vector. So a decoder for this cannot be a function from bytes to
 * pixels: it has to hold the two previous frames, and decoding frame *n*
 * requires having decoded every frame before it.
 *
 * Two buffers, swapped rather than copied. `nextOffs` is the distance from the
 * buffer being written to the other one, so a block code either reaches
 * backwards within this frame or across into the last one, using the same
 * addition — which is why the offsets are signed and why the table is built
 * against the frame pitch rather than being constant.
 *
 * (`SmushDeltaBlocksDecoder` in ScummVM's `codec37.cpp`. The motion table below
 * is the format's own data, as the opcode numbering in the script engines is.)
 */

/**
 * Motion vectors, as x/y pairs, in 255-entry pages.
 *
 * A frame header names which page to use, so the same block code means
 * different displacements in different frames. Reading the wrong page produces
 * a picture assembled from the right blocks in the wrong places — recognisably
 * the right scene, visibly wrong, and passing every check that is not a person
 * looking at it.
 */
const MOTION_VECTORS = new Int8Array([
  0, 0, 1, 0, 2, 0, 3, 0, 5, 0, 8, 0, 13, 0, 21, 0, -1, 0, -2, 0, -3, 0, -5, 0, -8, 0, -13, 0, -17,
  0, -21, 0, 0, 1, 1, 1, 2, 1, 3, 1, 5, 1, 8, 1, 13, 1, 21, 1, -1, 1, -2, 1, -3, 1, -5, 1, -8, 1,
  -13, 1, -17, 1, -21, 1, 0, 2, 1, 2, 2, 2, 3, 2, 5, 2, 8, 2, 13, 2, 21, 2, -1, 2, -2, 2, -3, 2, -5,
  2, -8, 2, -13, 2, -17, 2, -21, 2, 0, 3, 1, 3, 2, 3, 3, 3, 5, 3, 8, 3, 13, 3, 21, 3, -1, 3, -2, 3,
  -3, 3, -5, 3, -8, 3, -13, 3, -17, 3, -21, 3, 0, 5, 1, 5, 2, 5, 3, 5, 5, 5, 8, 5, 13, 5, 21, 5, -1,
  5, -2, 5, -3, 5, -5, 5, -8, 5, -13, 5, -17, 5, -21, 5, 0, 8, 1, 8, 2, 8, 3, 8, 5, 8, 8, 8, 13, 8,
  21, 8, -1, 8, -2, 8, -3, 8, -5, 8, -8, 8, -13, 8, -17, 8, -21, 8, 0, 13, 1, 13, 2, 13, 3, 13, 5,
  13, 8, 13, 13, 13, 21, 13, -1, 13, -2, 13, -3, 13, -5, 13, -8, 13, -13, 13, -17, 13, -21, 13, 0,
  21, 1, 21, 2, 21, 3, 21, 5, 21, 8, 21, 13, 21, 21, 21, -1, 21, -2, 21, -3, 21, -5, 21, -8, 21,
  -13, 21, -17, 21, -21, 21, 0, -1, 1, -1, 2, -1, 3, -1, 5, -1, 8, -1, 13, -1, 21, -1, -1, -1, -2,
  -1, -3, -1, -5, -1, -8, -1, -13, -1, -17, -1, -21, -1, 0, -2, 1, -2, 2, -2, 3, -2, 5, -2, 8, -2,
  13, -2, 21, -2, -1, -2, -2, -2, -3, -2, -5, -2, -8, -2, -13, -2, -17, -2, -21, -2, 0, -3, 1, -3,
  2, -3, 3, -3, 5, -3, 8, -3, 13, -3, 21, -3, -1, -3, -2, -3, -3, -3, -5, -3, -8, -3, -13, -3, -17,
  -3, -21, -3, 0, -5, 1, -5, 2, -5, 3, -5, 5, -5, 8, -5, 13, -5, 21, -5, -1, -5, -2, -5, -3, -5, -5,
  -5, -8, -5, -13, -5, -17, -5, -21, -5, 0, -8, 1, -8, 2, -8, 3, -8, 5, -8, 8, -8, 13, -8, 21, -8,
  -1, -8, -2, -8, -3, -8, -5, -8, -8, -8, -13, -8, -17, -8, -21, -8, 0, -13, 1, -13, 2, -13, 3, -13,
  5, -13, 8, -13, 13, -13, 21, -13, -1, -13, -2, -13, -3, -13, -5, -13, -8, -13, -13, -13, -17, -13,
  -21, -13, 0, -17, 1, -17, 2, -17, 3, -17, 5, -17, 8, -17, 13, -17, 21, -17, -1, -17, -2, -17, -3,
  -17, -5, -17, -8, -17, -13, -17, -17, -17, -21, -17, 0, -21, 1, -21, 2, -21, 3, -21, 5, -21, 8,
  -21, 13, -21, 21, -21, -1, -21, -2, -21, -3, -21, -5, -21, -8, -21, -13, -21, -17, -21, 0, 0, -8,
  -29, 8, -29, -18, -25, 17, -25, 0, -23, -6, -22, 6, -22, -13, -19, 12, -19, 0, -18, 25, -18, -25,
  -17, -5, -17, 5, -17, -10, -15, 10, -15, 0, -14, -4, -13, 4, -13, 19, -13, -19, -12, -8, -11, -2,
  -11, 0, -11, 2, -11, 8, -11, -15, -10, -4, -10, 4, -10, 15, -10, -6, -9, -1, -9, 1, -9, 6, -9,
  -29, -8, -11, -8, -8, -8, -3, -8, 3, -8, 8, -8, 11, -8, 29, -8, -5, -7, -2, -7, 0, -7, 2, -7, 5,
  -7, -22, -6, -9, -6, -6, -6, -3, -6, -1, -6, 1, -6, 3, -6, 6, -6, 9, -6, 22, -6, -17, -5, -7, -5,
  -4, -5, -2, -5, 0, -5, 2, -5, 4, -5, 7, -5, 17, -5, -13, -4, -10, -4, -5, -4, -3, -4, -1, -4, 0,
  -4, 1, -4, 3, -4, 5, -4, 10, -4, 13, -4, -8, -3, -6, -3, -4, -3, -3, -3, -2, -3, -1, -3, 0, -3, 1,
  -3, 2, -3, 4, -3, 6, -3, 8, -3, -11, -2, -7, -2, -5, -2, -3, -2, -2, -2, -1, -2, 0, -2, 1, -2, 2,
  -2, 3, -2, 5, -2, 7, -2, 11, -2, -9, -1, -6, -1, -4, -1, -3, -1, -2, -1, -1, -1, 0, -1, 1, -1, 2,
  -1, 3, -1, 4, -1, 6, -1, 9, -1, -31, 0, -23, 0, -18, 0, -14, 0, -11, 0, -7, 0, -5, 0, -4, 0, -3,
  0, -2, 0, -1, 0, 0, -31, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 7, 0, 11, 0, 14, 0, 18, 0, 23, 0, 31, 0,
  -9, 1, -6, 1, -4, 1, -3, 1, -2, 1, -1, 1, 0, 1, 1, 1, 2, 1, 3, 1, 4, 1, 6, 1, 9, 1, -11, 2, -7, 2,
  -5, 2, -3, 2, -2, 2, -1, 2, 0, 2, 1, 2, 2, 2, 3, 2, 5, 2, 7, 2, 11, 2, -8, 3, -6, 3, -4, 3, -2, 3,
  -1, 3, 0, 3, 1, 3, 2, 3, 3, 3, 4, 3, 6, 3, 8, 3, -13, 4, -10, 4, -5, 4, -3, 4, -1, 4, 0, 4, 1, 4,
  3, 4, 5, 4, 10, 4, 13, 4, -17, 5, -7, 5, -4, 5, -2, 5, 0, 5, 2, 5, 4, 5, 7, 5, 17, 5, -22, 6, -9,
  6, -6, 6, -3, 6, -1, 6, 1, 6, 3, 6, 6, 6, 9, 6, 22, 6, -5, 7, -2, 7, 0, 7, 2, 7, 5, 7, -29, 8,
  -11, 8, -8, 8, -3, 8, 3, 8, 8, 8, 11, 8, 29, 8, -6, 9, -1, 9, 1, 9, 6, 9, -15, 10, -4, 10, 4, 10,
  15, 10, -8, 11, -2, 11, 0, 11, 2, 11, 8, 11, 19, 12, -19, 13, -4, 13, 4, 13, 0, 14, -10, 15, 10,
  15, -5, 17, 5, 17, 25, 17, -25, 18, 0, 18, -12, 19, 13, 19, -6, 22, 6, 22, 0, 23, -17, 25, 18, 25,
  -8, 29, 8, 29, 0, 31, 0, 0, -6, -22, 6, -22, -13, -19, 12, -19, 0, -18, -5, -17, 5, -17, -10, -15,
  10, -15, 0, -14, -4, -13, 4, -13, 19, -13, -19, -12, -8, -11, -2, -11, 0, -11, 2, -11, 8, -11,
  -15, -10, -4, -10, 4, -10, 15, -10, -6, -9, -1, -9, 1, -9, 6, -9, -11, -8, -8, -8, -3, -8, 0, -8,
  3, -8, 8, -8, 11, -8, -5, -7, -2, -7, 0, -7, 2, -7, 5, -7, -22, -6, -9, -6, -6, -6, -3, -6, -1,
  -6, 1, -6, 3, -6, 6, -6, 9, -6, 22, -6, -17, -5, -7, -5, -4, -5, -2, -5, -1, -5, 0, -5, 1, -5, 2,
  -5, 4, -5, 7, -5, 17, -5, -13, -4, -10, -4, -5, -4, -3, -4, -2, -4, -1, -4, 0, -4, 1, -4, 2, -4,
  3, -4, 5, -4, 10, -4, 13, -4, -8, -3, -6, -3, -4, -3, -3, -3, -2, -3, -1, -3, 0, -3, 1, -3, 2, -3,
  3, -3, 4, -3, 6, -3, 8, -3, -11, -2, -7, -2, -5, -2, -4, -2, -3, -2, -2, -2, -1, -2, 0, -2, 1, -2,
  2, -2, 3, -2, 4, -2, 5, -2, 7, -2, 11, -2, -9, -1, -6, -1, -5, -1, -4, -1, -3, -1, -2, -1, -1, -1,
  0, -1, 1, -1, 2, -1, 3, -1, 4, -1, 5, -1, 6, -1, 9, -1, -23, 0, -18, 0, -14, 0, -11, 0, -7, 0, -5,
  0, -4, 0, -3, 0, -2, 0, -1, 0, 0, -23, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 7, 0, 11, 0, 14, 0, 18, 0,
  23, 0, -9, 1, -6, 1, -5, 1, -4, 1, -3, 1, -2, 1, -1, 1, 0, 1, 1, 1, 2, 1, 3, 1, 4, 1, 5, 1, 6, 1,
  9, 1, -11, 2, -7, 2, -5, 2, -4, 2, -3, 2, -2, 2, -1, 2, 0, 2, 1, 2, 2, 2, 3, 2, 4, 2, 5, 2, 7, 2,
  11, 2, -8, 3, -6, 3, -4, 3, -3, 3, -2, 3, -1, 3, 0, 3, 1, 3, 2, 3, 3, 3, 4, 3, 6, 3, 8, 3, -13, 4,
  -10, 4, -5, 4, -3, 4, -2, 4, -1, 4, 0, 4, 1, 4, 2, 4, 3, 4, 5, 4, 10, 4, 13, 4, -17, 5, -7, 5, -4,
  5, -2, 5, -1, 5, 0, 5, 1, 5, 2, 5, 4, 5, 7, 5, 17, 5, -22, 6, -9, 6, -6, 6, -3, 6, -1, 6, 1, 6, 3,
  6, 6, 6, 9, 6, 22, 6, -5, 7, -2, 7, 0, 7, 2, 7, 5, 7, -11, 8, -8, 8, -3, 8, 0, 8, 3, 8, 8, 8, 11,
  8, -6, 9, -1, 9, 1, 9, 6, 9, -15, 10, -4, 10, 4, 10, 15, 10, -8, 11, -2, 11, 0, 11, 2, 11, 8, 11,
  19, 12, -19, 13, -4, 13, 4, 13, 0, 14, -10, 15, 10, 15, -5, 17, 5, 17, 0, 18, -12, 19, 13, 19, -6,
  22, 6, 22, 0, 23,
]);

/** One page of vectors, resolved against a frame's pitch. */
function buildOffsetTable(pitch: number, page: number): Int32Array {
  const table = new Int32Array(255);
  const base = page * 255;
  for (let i = 0; i < 255; i++) {
    const at = (i + base) * 2;
    table[i] = MOTION_VECTORS[at + 1] * pitch + MOTION_VECTORS[at];
  }
  return table;
}

/**
 * Decodes a stream of codec 37 frames.
 *
 * Stateful by necessity, not by choice: see the header. Construct one per
 * sequence and feed it frames in order.
 */
export class Codec37Decoder {
  private readonly width: number;
  private readonly height: number;
  private readonly frameSize: number;
  private readonly buffers: [Uint8Array, Uint8Array];
  private current = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.frameSize = width * height;
    this.buffers = [new Uint8Array(this.frameSize), new Uint8Array(this.frameSize)];
  }

  /**
   * Decodes one frame into `out`, which must hold a whole frame.
   *
   * Returns false for a frame this cannot decode — an unknown sub-codec — so
   * the caller can name it rather than leaving the previous frame up, which
   * looks like a stalled video.
   */
  decode(src: Uint8Array, out: Uint8Array): boolean {
    if (src.length < 16) return false;

    const bw = Math.ceil(this.width / 4);
    const bh = Math.ceil(this.height / 4);
    const pitch = bw * 4;

    const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
    const kind = src[0];
    const page = src[1];
    const seqNb = view.getUint16(2, true);
    const decodedSize = view.getUint32(4, true);
    const maskFlags = src[12];

    const offsets = buildOffsetTable(pitch, page);
    const data = src.subarray(16);

    // The buffers swap on an odd sequence number, or when the frame says not to
    // hold the previous one. Getting this backwards makes every motion vector
    // point at the wrong frame, which is the whole picture smeared by one step.
    const swap = () => {
      if (seqNb & 1 || !(maskFlags & 1)) this.current ^= 1;
    };

    const dst = this.buffers[this.current];

    switch (kind) {
      case 0:
        dst.fill(0);
        dst.set(data.subarray(0, Math.min(decodedSize, dst.length)));
        break;

      case 1:
        swap();
        this.proc1(data, offsets, bw, bh, pitch);
        break;

      case 2:
        dst.fill(0);
        decodeRleInto(data, this.buffers[this.current], decodedSize);
        break;

      case 3:
        swap();
        this.procBlocks(data, offsets, bw, bh, pitch, (maskFlags & 4) !== 0, false);
        break;

      case 4:
        swap();
        this.procBlocks(data, offsets, bw, bh, pitch, (maskFlags & 4) !== 0, true);
        break;

      default:
        return false;
    }

    out.set(this.buffers[this.current].subarray(0, Math.min(this.frameSize, out.length)));
    return true;
  }

  /** The other buffer, as a signed distance from the one being written. */
  private get otherBuffer(): Uint8Array {
    return this.buffers[this.current ^ 1];
  }

  /** Copies a 4x4 block from `from` in either buffer to `to` in the current one. */
  private copyBlock(from: number, to: number, pitch: number, fromOther: boolean): void {
    const source = fromOther ? this.otherBuffer : this.buffers[this.current];
    const dst = this.buffers[this.current];
    for (let y = 0; y < 4; y++) {
      const src = from + pitch * y;
      const at = to + pitch * y;
      if (src < 0 || src + 4 > source.length || at + 4 > dst.length) continue;
      dst[at] = source[src];
      dst[at + 1] = source[src + 1];
      dst[at + 2] = source[src + 2];
      dst[at + 3] = source[src + 3];
    }
  }

  /**
   * Sub-codec 1: a run-length stream over block codes.
   *
   * A length byte's low bit says whether the run repeats one code or reads a
   * fresh one each time, and code 0xFF escapes to sixteen literal pixels — which
   * may themselves be run-length encoded, so the length counter is shared
   * between the two levels. That sharing is the part worth care: treating the
   * inner run as its own counter desynchronises the stream a block at a time.
   */
  private proc1(src: Uint8Array, offsets: Int32Array, bw: number, bh: number, pitch: number): void {
    const dstBuf = this.buffers[this.current];
    const pitches: number[] = [];
    for (let p = 0; p < 16; p++) pitches.push((p >> 2) * pitch + (p & 3));

    let read = 0;
    let dst = 0;
    let i = bw;
    let rows = bh;
    let code = 0;
    let filling = false;
    let len = -1;

    for (;;) {
      let skipCode = true;
      if (len < 0) {
        if (read >= src.length) return;
        filling = (src[read] & 1) === 1;
        len = src[read++] >> 1;
        skipCode = false;
      }

      if (!filling || !skipCode) {
        if (read >= src.length) return;
        code = src[read++];
        if (code === 0xff) {
          len--;
          for (let p = 0; p < 16; p++) {
            if (len < 0) {
              if (read >= src.length) return;
              filling = (src[read] & 1) === 1;
              len = src[read++] >> 1;
              if (filling) code = src[read++];
            }
            const at = dst + pitches[p];
            if (at < dstBuf.length) dstBuf[at] = filling ? code : src[read];
            if (!filling) read++;
            len--;
          }
          dst += 4;
          if (--i === 0) {
            dst += pitch * 3;
            if (--rows === 0) return;
            i = bw;
          }
          continue;
        }
      }

      this.copyBlock(dst + offsets[code], dst, pitch, true);
      dst += 4;
      if (--i === 0) {
        dst += pitch * 3;
        if (--rows === 0) return;
        i = bw;
      }
      len--;
    }
  }

  /**
   * Sub-codecs 3 and 4: one code per block, with literal escapes.
   *
   * 0xFD fills a block with one colour, 0xFE writes four rows of four, 0xFF
   * sixteen literal pixels, and anything else is a motion vector. Sub-codec 4
   * adds a 0x00 run meaning "this many blocks unchanged from the last frame",
   * which is what makes a still scene nearly free.
   */
  private procBlocks(
    src: Uint8Array,
    offsets: Int32Array,
    bw: number,
    bh: number,
    pitch: number,
    withEscapes: boolean,
    withRuns: boolean,
  ): void {
    const dstBuf = this.buffers[this.current];
    let read = 0;
    let dst = 0;
    let rows = bh;

    while (rows > 0) {
      let i = bw;
      while (i > 0) {
        if (read >= src.length) return;
        const code = src[read++];

        if (withEscapes && code === 0xfd) {
          const colour = src[read++];
          for (let y = 0; y < 4; y++) dstBuf.fill(colour, dst + pitch * y, dst + pitch * y + 4);
          dst += 4;
        } else if (withEscapes && code === 0xfe) {
          for (let y = 0; y < 4; y++) {
            const colour = src[read++];
            dstBuf.fill(colour, dst + pitch * y, dst + pitch * y + 4);
          }
          dst += 4;
        } else if (code === 0xff) {
          for (let y = 0; y < 4; y++) {
            for (let x = 0; x < 4; x++) dstBuf[dst + pitch * y + x] = src[read++];
          }
          dst += 4;
        } else if (withRuns && code === 0x00) {
          const length = src[read++] + 1;
          for (let l = 0; l < length; l++) {
            this.copyBlock(dst, dst, pitch, true);
            dst += 4;
            if (--i === 0) {
              dst += pitch * 3;
              if (--rows === 0) return;
              i = bw;
            }
          }
          i++;
        } else {
          this.copyBlock(dst + offsets[code], dst, pitch, true);
          dst += 4;
        }

        i--;
      }
      dst += pitch * 3;
      rows--;
    }
  }
}

/** Sub-codec 2's payload: one run-length stream over the whole frame. */
function decodeRleInto(src: Uint8Array, out: Uint8Array, limit: number): void {
  let read = 0;
  let write = 0;
  while (write < limit && write < out.length && read < src.length) {
    const code = src[read++];
    const count = Math.min((code >> 1) + 1, limit - write);
    if (code & 1) {
      out.fill(src[read++], write, write + count);
    } else {
      for (let i = 0; i < count; i++) out[write + i] = src[read + i];
      read += count;
    }
    write += count;
  }
}
