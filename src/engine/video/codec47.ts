/**
 * SMUSH codec 47: motion-compensated blocks with a generated glyph table.
 *
 * The workhorse. Full Throttle and The Dig encode most of their video with it,
 * and it is codec 37's idea taken further: a frame is decoded at three block
 * sizes — 8x8, then 4x4, then 2x2 — with a code at each level either resolving
 * the block or saying "subdivide". Beneath that sits a **glyph table**, two
 * hundred and fifty-six two-colour patterns, so a block containing an edge can
 * be sent as a pattern index and two colours rather than as pixels.
 *
 * The glyph table is *generated*, not stored: each glyph is the line between
 * two of sixteen points around the block's border, interpolated and then filled
 * to one side. That generation is reproduced here because the table is the
 * format — a decoder with a differently-built table produces edges in the wrong
 * places, which reads as a slightly soft picture rather than as a fault.
 *
 * Three buffers, rotated per frame: two deltas and the one being written. The
 * frame header says how they rotate, and getting that wrong smears the whole
 * picture by one frame.
 *
 * (`SmushDeltaGlyphsDecoder` in ScummVM's `codec47.cpp`.)
 */

/** Codes at or above these are not motion vectors but instructions. */
const MOTION_OFFSET_TABLE_SIZE = 0xf8;
const PROCESS_SUBBLOCKS = 0xff;
const FILL_SINGLE_COLOR = 0xfe;
const DRAW_GLYPH = 0xfd;
const COPY_PREV_BUFFER = 0xfc;

/** Motion vectors as x/y pairs, resolved against the frame width. */
const MOTION_VECTORS = new Int8Array([
  0, 0, -1, -43, 6, -43, -9, -42, 13, -41, -16, -40, 19, -39, -23, -36, 26, -34, -2, -33, 4, -33,
  -29, -32, -9, -32, 11, -31, -16, -29, 32, -29, 18, -28, -34, -26, -22, -25, -1, -25, 3, -25, -7,
  -24, 8, -24, 24, -23, 36, -23, -12, -22, 13, -21, -38, -20, 0, -20, -27, -19, -4, -19, 4, -19,
  -17, -18, -8, -17, 8, -17, 18, -17, 28, -17, 39, -17, -12, -15, 12, -15, -21, -14, -1, -14, 1,
  -14, -41, -13, -5, -13, 5, -13, 21, -13, -31, -12, -15, -11, -8, -11, 8, -11, 15, -11, -2, -10, 1,
  -10, 31, -10, -23, -9, -11, -9, -5, -9, 4, -9, 11, -9, 42, -9, 6, -8, 24, -8, -18, -7, -7, -7, -3,
  -7, -1, -7, 2, -7, 18, -7, -43, -6, -13, -6, -4, -6, 4, -6, 8, -6, -33, -5, -9, -5, -2, -5, 0, -5,
  2, -5, 5, -5, 13, -5, -25, -4, -6, -4, -3, -4, 3, -4, 9, -4, -19, -3, -7, -3, -4, -3, -2, -3, -1,
  -3, 0, -3, 1, -3, 2, -3, 4, -3, 6, -3, 33, -3, -14, -2, -10, -2, -5, -2, -3, -2, -2, -2, -1, -2,
  0, -2, 1, -2, 2, -2, 3, -2, 5, -2, 7, -2, 14, -2, 19, -2, 25, -2, 43, -2, -7, -1, -3, -1, -2, -1,
  -1, -1, 0, -1, 1, -1, 2, -1, 3, -1, 10, -1, -5, 0, -3, 0, -2, 0, -1, 0, 1, 0, 2, 0, 3, 0, 5, 0, 7,
  0, -10, 1, -7, 1, -3, 1, -2, 1, -1, 1, 0, 1, 1, 1, 2, 1, 3, 1, -43, 2, -25, 2, -19, 2, -14, 2, -5,
  2, -3, 2, -2, 2, -1, 2, 0, 2, 1, 2, 2, 2, 3, 2, 5, 2, 7, 2, 10, 2, 14, 2, -33, 3, -6, 3, -4, 3,
  -2, 3, -1, 3, 0, 3, 1, 3, 2, 3, 4, 3, 19, 3, -9, 4, -3, 4, 3, 4, 7, 4, 25, 4, -13, 5, -5, 5, -2,
  5, 0, 5, 2, 5, 5, 5, 9, 5, 33, 5, -8, 6, -4, 6, 4, 6, 13, 6, 43, 6, -18, 7, -2, 7, 0, 7, 2, 7, 7,
  7, 18, 7, -24, 8, -6, 8, -42, 9, -11, 9, -4, 9, 5, 9, 11, 9, 23, 9, -31, 10, -1, 10, 2, 10, -15,
  11, -8, 11, 8, 11, 15, 11, 31, 12, -21, 13, -5, 13, 5, 13, 41, 13, -1, 14, 1, 14, 21, 14, -12, 15,
  12, 15, -39, 17, -28, 17, -18, 17, -8, 17, 8, 17, 17, 18, -4, 19, 0, 19, 4, 19, 27, 19, 38, 20,
  -13, 21, 12, 22, -36, 23, -24, 23, -8, 24, 7, 24, -3, 25, 1, 25, 22, 25, 34, 26, -18, 28, -32, 29,
  16, 29, -11, 31, 9, 32, 29, 32, -4, 33, 2, 33, -26, 34, 23, 36, -19, 39, 16, 40, -13, 41, 9, 42,
  -6, 43, 1, 43, 0, 0, 0, 0, 0, 0,
]);

/** The sixteen points around a block's border that a glyph's line runs between. */
const GLYPH4_X = new Int8Array([0, 1, 2, 3, 3, 3, 3, 2, 1, 0, 0, 0, 1, 2, 2, 1]);
const GLYPH4_Y = new Int8Array([0, 0, 0, 0, 1, 2, 3, 3, 3, 3, 2, 1, 1, 1, 2, 2]);
const GLYPH8_X = new Int8Array([0, 2, 5, 7, 7, 7, 7, 7, 7, 5, 2, 0, 0, 0, 0, 0]);
const GLYPH8_Y = new Int8Array([0, 0, 0, 0, 1, 3, 4, 6, 7, 7, 7, 7, 6, 4, 3, 1]);

/** Which border a point sits on, which decides how its line is filled. */
const enum Edge {
  None = 0,
  Left,
  Top,
  Right,
  Bottom,
}

function edgeOf(x: number, y: number, side: number): Edge {
  if (y === 0) return Edge.Bottom;
  if (y === side - 1) return Edge.Top;
  if (x === 0) return Edge.Left;
  if (x === side - 1) return Edge.Right;
  return Edge.None;
}

/** One glyph: the pixels on each side of its line, as offsets into a block. */
interface Glyph {
  inside: number[];
  outside: number[];
}

/**
 * Builds the 256 glyphs for a block of `side` pixels.
 *
 * Each glyph is the line between points `a` and `b` of the sixteen around the
 * border, interpolated pixel by pixel and then flooded to one side according to
 * which borders the two ends sit on. The result is split into the pixels the
 * line covers and those it does not, which is what lets a block be sent as an
 * index and two colours.
 */
function buildGlyphs(side: number, xVec: Int8Array, yVec: Int8Array): Glyph[] {
  const glyphs: Glyph[] = [];
  const area = side * side;

  for (let a = 0; a < 16; a++) {
    const x0 = xVec[a];
    const y0 = yVec[a];
    const edge0 = edgeOf(x0, y0, side);

    for (let b = 0; b < 16; b++) {
      const x1 = xVec[b];
      const y1 = yVec[b];
      const edge1 = edgeOf(x1, y1, side);

      const mask = new Uint8Array(area);
      const points = Math.max(Math.abs(y1 - y0), Math.abs(x1 - x0));

      for (let pos = 0; pos <= points; pos++) {
        let xPoint: number;
        let yPoint: number;
        if (points > 0) {
          xPoint = Math.trunc((x0 * pos + x1 * (points - pos) + points / 2) / points);
          yPoint = Math.trunc((y0 * pos + y1 * (points - pos) + points / 2) / points);
        } else {
          xPoint = x0;
          yPoint = y0;
        }

        let at = side * yPoint + xPoint;
        mask[at] = 1;

        // Which way the line floods depends on the pair of borders its ends sit
        // on, not on the line itself. Six cases, and they are not symmetric:
        // this is the part where a plausible simplification gives edges facing
        // the wrong way.
        if (
          (edge0 === Edge.Left && edge1 === Edge.Right) ||
          (edge1 === Edge.Left && edge0 === Edge.Right) ||
          (edge0 === Edge.Bottom && edge1 !== Edge.Top) ||
          (edge1 === Edge.Bottom && edge0 !== Edge.Top)
        ) {
          for (let i = yPoint; i >= 0; i--) {
            if (at >= 0 && at < area) mask[at] = 1;
            at -= side;
          }
        } else if (
          (edge1 !== Edge.Bottom && edge0 === Edge.Top) ||
          (edge0 !== Edge.Bottom && edge1 === Edge.Top)
        ) {
          for (let i = side - yPoint; i > 0; i--) {
            if (at >= 0 && at < area) mask[at] = 1;
            at += side;
          }
        } else if (
          (edge0 === Edge.Left && edge1 !== Edge.Right) ||
          (edge1 === Edge.Left && edge0 !== Edge.Right)
        ) {
          for (let i = xPoint; i >= 0; i--) {
            if (at >= 0 && at < area) mask[at] = 1;
            at--;
          }
        } else if (
          (edge0 === Edge.Bottom && edge1 === Edge.Top) ||
          (edge1 === Edge.Bottom && edge0 === Edge.Top) ||
          (edge0 === Edge.Right && edge1 !== Edge.Left) ||
          (edge1 === Edge.Right && edge0 !== Edge.Left)
        ) {
          for (let i = side - xPoint; i > 0; i--) {
            if (at >= 0 && at < area) mask[at] = 1;
            at++;
          }
        }
      }

      // Highest index first, as the reference builds them; the order decides
      // which pixels a partially-written glyph leaves behind.
      const inside: number[] = [];
      const outside: number[] = [];
      for (let i = area - 1; i >= 0; i--) {
        if (mask[i]) inside.push(i);
        else outside.push(i);
      }
      glyphs.push({ inside, outside });
    }
  }

  return glyphs;
}

/**
 * Decodes a stream of codec 47 frames.
 *
 * Stateful, like codec 37 and for the same reason: most blocks reference the
 * two previous frames. Construct one per sequence and feed it frames in order.
 */
export class Codec47Decoder {
  private readonly width: number;
  private readonly height: number;
  private readonly frameSize: number;

  /** Two deltas and the frame being built. Rotated, never copied. */
  private readonly buffers: [Uint8Array, Uint8Array, Uint8Array];
  private prevSeqNb = -1;
  private tableWidth = -1;

  private readonly motion = new Int32Array(256);
  private readonly glyphs4: Glyph[];
  private readonly glyphs8: Glyph[];

  /** Per-frame decode state, held on the instance as the reference does. */
  private src: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private read = 0;
  private params = 0;
  private pitch = 0;
  private offset1 = 0;
  private offset2 = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.frameSize = width * height;
    this.buffers = [
      new Uint8Array(this.frameSize),
      new Uint8Array(this.frameSize),
      new Uint8Array(this.frameSize),
    ];
    this.glyphs4 = buildGlyphs(4, GLYPH4_X, GLYPH4_Y);
    this.glyphs8 = buildGlyphs(8, GLYPH8_X, GLYPH8_Y);
  }

  /** Motion vectors resolved against this frame's width. */
  private buildMotionTable(width: number): void {
    if (this.tableWidth === width) return;
    this.tableWidth = width;
    for (let i = 0; i < 255; i++) {
      this.motion[i] = MOTION_VECTORS[i * 2 + 1] * width + MOTION_VECTORS[i * 2];
    }
  }

  /**
   * Decodes one frame into `out`.
   *
   * Returns false for a sub-codec this does not implement — including case 1,
   * which ScummVM records as Outlaws' and which no SCUMM game uses.
   */
  decode(src: Uint8Array<ArrayBufferLike>, out: Uint8Array): boolean {
    if (src.length < 26) return false;

    const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
    const seqNb = view.getUint16(0, true);
    const kind = src[2];
    const rotation = src[3];
    let gfx = 26;

    if (seqNb === 0) {
      this.buildMotionTable(this.width);
      this.buffers[0].fill(src[12]);
      this.buffers[1].fill(src[13]);
      this.prevSeqNb = -1;
    }

    // A flag byte that shifts the payload by a fixed block. Missing it reads
    // the frame's own table as pixel data.
    if (src[4] & 1) gfx += 32896;

    this.pitch = this.width;
    this.offset1 = 1;
    this.offset2 = 0;

    switch (kind) {
      case 0:
        this.buffers[2].set(src.subarray(gfx, gfx + this.frameSize) as Uint8Array<ArrayBuffer>);
        break;

      case 2:
        if (seqNb === this.prevSeqNb + 1) {
          this.src = src;
          this.read = gfx;
          this.params = 8;
          this.decodeBlocks();
        }
        break;

      case 3:
        this.buffers[2].set(this.buffers[1]);
        break;

      case 4:
        this.buffers[2].set(this.buffers[0]);
        break;

      case 5:
        decodeRleInto(src.subarray(gfx), this.buffers[2], view.getUint32(14, true));
        break;

      default:
        return false;
    }

    out.set(this.buffers[2].subarray(0, Math.min(this.frameSize, out.length)));

    // The rotation the header asks for. Written as swaps rather than copies,
    // because the buffers are frame-sized and this happens every frame.
    if (seqNb === this.prevSeqNb + 1) {
      if (rotation === 1) {
        [this.buffers[2], this.buffers[1]] = [this.buffers[1], this.buffers[2]];
      } else if (rotation === 2) {
        [this.buffers[0], this.buffers[1]] = [this.buffers[1], this.buffers[0]];
        [this.buffers[1], this.buffers[2]] = [this.buffers[2], this.buffers[1]];
      }
    }
    this.prevSeqNb = seqNb;
    return true;
  }

  /** Walks the frame in 8x8 blocks, subdividing as the codes ask. */
  private decodeBlocks(): void {
    const bw = Math.ceil(this.width / 8);
    const bh = Math.ceil(this.height / 8);

    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        this.level(bx * 8 + by * 8 * this.pitch, 8);
      }
    }
  }

  /**
   * Resolves one block, at 8, 4 or 2 pixels square.
   *
   * The same five codes at every size, which is what makes the recursion
   * uniform: a motion vector, a subdivide, a flat fill, a glyph, or a copy from
   * the other delta buffer.
   */
  private level(dst: number, size: number): void {
    if (this.read >= this.src.length) return;
    const code = this.src[this.read++];
    const dstBuf = this.buffers[2];

    if (code < MOTION_OFFSET_TABLE_SIZE) {
      this.copyBlock(dst + this.motion[code], dst, size, this.buffers[this.offset1]);
      return;
    }

    if (code === PROCESS_SUBBLOCKS) {
      if (size === 2) {
        // The floor: four literal pixels rather than a further subdivision.
        for (let y = 0; y < 2; y++) {
          for (let x = 0; x < 2; x++) {
            dstBuf[dst + y * this.pitch + x] = this.src[this.read++];
          }
        }
        return;
      }
      const half = size >> 1;
      this.level(dst, half);
      this.level(dst + half, half);
      this.level(dst + half * this.pitch, half);
      this.level(dst + half * this.pitch + half, half);
      return;
    }

    if (code === FILL_SINGLE_COLOR) {
      const colour = this.src[this.read++];
      for (let y = 0; y < size; y++) {
        dstBuf.fill(colour, dst + y * this.pitch, dst + y * this.pitch + size);
      }
      return;
    }

    if (code === DRAW_GLYPH) {
      const glyphs = size === 8 ? this.glyphs8 : this.glyphs4;
      const glyph = glyphs[this.src[this.read++]];
      const inside = this.src[this.read++];
      const outside = this.src[this.read++];
      if (!glyph) return;
      for (const at of glyph.inside) this.writeGlyphPixel(dst, at, size, inside);
      for (const at of glyph.outside) this.writeGlyphPixel(dst, at, size, outside);
      return;
    }

    if (code === COPY_PREV_BUFFER) {
      this.copyBlock(dst, dst, size, this.buffers[this.offset2]);
      return;
    }

    // Everything above the instruction codes is a colour from the frame's own
    // parameter block, not a literal — reading it as one gives a picture in the
    // right shapes and the wrong colours.
    const colour = this.src[this.params + code];
    for (let y = 0; y < size; y++) {
      this.buffers[2].fill(colour, dst + y * this.pitch, dst + y * this.pitch + size);
    }
  }

  /** A glyph offset is a position within its own block, not the frame. */
  private writeGlyphPixel(dst: number, at: number, size: number, colour: number): void {
    const x = at % size;
    const y = (at / size) | 0;
    const target = dst + y * this.pitch + x;
    if (target >= 0 && target < this.buffers[2].length) this.buffers[2][target] = colour;
  }

  private copyBlock(from: number, to: number, size: number, source: Uint8Array): void {
    const dst = this.buffers[2];
    for (let y = 0; y < size; y++) {
      const src = from + y * this.pitch;
      const at = to + y * this.pitch;
      if (src < 0 || src + size > source.length || at + size > dst.length) continue;
      dst.set(source.subarray(src, src + size), at);
    }
  }
}

/** Sub-codec 5's payload: one run-length stream over the whole frame. */
function decodeRleInto(src: Uint8Array, out: Uint8Array, limit: number): void {
  let read = 0;
  let write = 0;
  const end = Math.min(limit, out.length);
  while (write < end && read < src.length) {
    const code = src[read++];
    const count = Math.min((code >> 1) + 1, end - write);
    if (code & 1) {
      out.fill(src[read++], write, write + count);
    } else {
      for (let i = 0; i < count; i++) out[write + i] = src[read + i];
      read += count;
    }
    write += count;
  }
}
