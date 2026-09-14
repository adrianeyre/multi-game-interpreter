/**
 * SCUMM background bitmap decoders.
 *
 * A background image (SMAP) is split into vertical 8 pixel strips, each
 * compressed independently with one of a family of codecs. The first byte of a
 * strip selects the codec; the low digit of that byte is the number of bits a
 * literal colour index occupies.
 *
 * The families, using ScummVM's naming:
 *
 *   1              raw 8 bit pixels
 *   10-18 / 30-38  "zigzag", vertical scan   (30+ = transparent)
 *   20-28 / 40-48  "zigzag", horizontal scan (40+ = transparent)
 *   60-68 / 80-88  major/minor deltas        (80+ = transparent)
 *   100-108 / 120-128  as above, with run-length repeats
 *   130-138 / 140-148  major/minor with a wider delta range
 *   149            raw 8 bit pixels, transparent
 *
 * Every decoder writes 8-pixel-wide columns of palette indices into `dst` at
 * `dstOffset`, advancing `dstStride` bytes per row.
 */

export interface StripTarget {
  /** Destination buffer of palette indices. */
  dst: Uint8Array;
  /** Byte offset of the strip's top-left pixel. */
  dstOffset: number;
  /** Bytes between vertically adjacent pixels. */
  dstStride: number;
  /** Number of rows to decode. */
  height: number;
  /**
   * Colour treated as "leave the destination alone" for transparent codecs.
   * Rooms use 255 by default; the room's TRNS chunk can override it.
   */
  transparentColor: number;
  /**
   * Optional palette remap applied to every decoded index. Identity for VGA;
   * used by the EGA and Amiga conversions.
   */
  roomPalette?: Uint8Array;
}

const STRIP_WIDTH = 8;

/**
 * The EGA strip codec, which is not a member of the family above.
 *
 * v2, v3 and the sixteen-colour v4 releases compress a strip with a scheme that
 * shares nothing with the VGA codecs: there is no leading code byte selecting a
 * variant, no bits-per-pixel digit, and the scan runs down each column rather
 * than across. Three cases, chosen by the top two bits of a control byte:
 *
 *   0xxxxxxx   a run of one colour — length in the high nibble, colour in the
 *              low one; a length of zero means the length is the next byte
 *   10xxxxxx   a run copying the pixel to the left, same length rule
 *   11xxxxxx   a *dithered* run of two colours, taken from the next byte's two
 *              nibbles and alternated pixel by pixel
 *
 * The dither case is the one worth stating, because it is the reason a strip
 * cannot be decoded a pixel at a time from the source: the pair of colours is
 * one byte and which of the two lands on a given pixel depends on how far into
 * the run it is. Reading it as two separate runs gives a picture that is the
 * right shape, the right size, and visibly striped.
 *
 * (`Gdi::drawStripEGA`.)
 */
export function decodeEgaStrip(src: Uint8Array, srcOffset: number, target: StripTarget): void {
  const { dst, dstOffset, dstStride, height, roomPalette } = target;
  const remap = (colour: number): number => (roomPalette ? roomPalette[colour] : colour);

  let at = srcOffset;
  let x = 0;
  let y = 0;

  const put = (colour: number): void => {
    if (x < STRIP_WIDTH && y < height) dst[dstOffset + y * dstStride + x] = colour;
    y++;
    if (y >= height) {
      y = 0;
      x++;
    }
  };

  while (x < STRIP_WIDTH && at < src.length) {
    const control = src[at++];

    if (!(control & 0x80)) {
      let run = control >> 4;
      if (run === 0) run = src[at++];
      const colour = remap(control & 0x0f);
      for (let i = 0; i < run; i++) put(colour);
      continue;
    }

    let run = control & 0x3f;

    if (control & 0x40) {
      const pair = src[at++];
      if (run === 0) run = src[at++];
      const odd = remap(pair & 0x0f);
      const even = remap(pair >> 4);
      for (let i = 0; i < run; i++) put(i & 1 ? odd : even);
      continue;
    }

    if (run === 0) run = src[at++];
    for (let i = 0; i < run; i++) {
      // Copy the pixel to the left, which for the first column of a strip is
      // the last column of the strip before it — so strips are decoded in
      // order into one buffer rather than independently.
      const from = dstOffset + y * dstStride + x - 1;
      put(x === 0 && dstOffset === 0 ? 0 : dst[from]);
    }
  }
}

/** True if this codec leaves `transparentColor` pixels untouched. */
export function isTransparentCodec(code: number): boolean {
  if (code === 149) return true;
  if (code >= 30 && code <= 38) return true;
  if (code >= 40 && code <= 48) return true;
  if (code >= 80 && code <= 88) return true;
  if (code >= 120 && code <= 128) return true;
  if (code >= 140 && code <= 148) return true;
  return false;
}

/**
 * Decodes one strip.
 *
 * @param src   strip data, positioned at the codec byte
 * @returns whether the strip contained transparent pixels, which the caller
 *          needs in order to decide if an object hides the background
 */
export function decodeStrip(src: Uint8Array, srcOffset: number, target: StripTarget): boolean {
  const code = src[srcOffset];
  const body = srcOffset + 1;
  const transparent = isTransparentCodec(code);
  // Bits per literal colour, encoded in the low digit of the codec byte.
  const shift = code % 10;
  const mask = shift >= 8 ? 0xff : (0xff >> (8 - shift)) & 0xff;

  switch (true) {
    case code === 1:
      drawStripRaw(src, body, target, false);
      break;
    case code === 149:
      drawStripRaw(src, body, target, true);
      break;

    case code >= 10 && code <= 18:
      drawStripBasicV(src, body, target, false, shift, mask);
      break;
    case code >= 30 && code <= 38:
      drawStripBasicV(src, body, target, true, shift, mask);
      break;

    case code >= 20 && code <= 28:
      drawStripBasicH(src, body, target, false, shift, mask);
      break;
    case code >= 40 && code <= 48:
      drawStripBasicH(src, body, target, true, shift, mask);
      break;

    case (code >= 60 && code <= 68) || (code >= 100 && code <= 108):
      drawStripComplex(src, body, target, false, shift);
      break;
    case (code >= 80 && code <= 88) || (code >= 120 && code <= 128):
      drawStripComplex(src, body, target, true, shift);
      break;

    case code >= 130 && code <= 138:
      drawStripMajMinWide(src, body, target, false, shift, mask);
      break;
    case code >= 140 && code <= 148:
      drawStripMajMinWide(src, body, target, true, shift, mask);
      break;

    default:
      // An unknown codec means the strip would be garbage; leaving the
      // destination untouched shows the previous contents rather than noise.
      return transparent;
  }
  return transparent;
}

function writePixel(target: StripTarget, index: number, color: number): void {
  const palette = target.roomPalette;
  target.dst[index] = palette ? palette[color & 0xff] : color;
}

/** Codec 1 / 149: eight raw bytes per row. */
function drawStripRaw(
  src: Uint8Array,
  srcOffset: number,
  target: StripTarget,
  transpCheck: boolean,
): void {
  let s = srcOffset;
  let row = target.dstOffset;
  for (let y = 0; y < target.height; y++) {
    for (let x = 0; x < STRIP_WIDTH; x++) {
      const color = src[s++];
      if (!transpCheck || color !== target.transparentColor) {
        writePixel(target, row + x, color);
      }
    }
    row += target.dstStride;
  }
}

/**
 * A one-bit-at-a-time reader shared by the zigzag codecs.
 *
 * The stream is little-endian at the bit level: bits are consumed from the low
 * end of an accumulator that is topped up a byte at a time.
 */
class BitReader {
  private bits = 0;
  private count = 0;
  private offset: number;
  private readonly src: Uint8Array;

  constructor(src: Uint8Array, offset: number) {
    this.src = src;
    this.offset = offset;
  }

  seed(value: number, count: number): void {
    this.bits = value;
    this.count = count;
  }

  /** Tops the accumulator up so at least 8 bits are available. */
  fill(): void {
    if (this.count <= 8) {
      this.bits |= (this.src[this.offset++] ?? 0) << this.count;
      this.count += 8;
    }
  }

  readBit(): number {
    const bit = this.bits & 1;
    this.bits >>>= 1;
    this.count--;
    return bit;
  }

  readBits(n: number, mask: number): number {
    const value = this.bits & mask;
    this.bits >>>= n;
    this.count -= n;
    return value;
  }
}

/** Mutable step direction shared between pixels of a zigzag strip. */
interface ZigzagState {
  inc: number;
}

/**
 * Reads one colour transition from a zigzag stream.
 *
 * The encoding is a prefix code read one bit at a time:
 *
 *   0     keep the current colour
 *   10    a literal colour follows, `shift` bits wide
 *   110   step the colour by the current increment
 *   111   flip the increment, then step
 *
 * The bits must be read in exactly this order because each `readBit` consumes
 * from the shared stream.
 */
function nextColor(
  reader: BitReader,
  color: number,
  shift: number,
  mask: number,
  state: ZigzagState,
): number {
  reader.fill();
  if (!reader.readBit()) return color;

  if (!reader.readBit()) {
    reader.fill();
    state.inc = -1;
    return reader.readBits(shift, mask);
  }

  if (reader.readBit()) state.inc = -state.inc;
  return (color + state.inc) & 0xff;
}

/**
 * Codecs 10-18 / 30-38: vertical scan.
 *
 * Each pixel is one of: repeat the previous colour, read a literal, step the
 * colour by the current increment, or flip the increment and step.
 */
function drawStripBasicV(
  src: Uint8Array,
  srcOffset: number,
  target: StripTarget,
  transpCheck: boolean,
  shift: number,
  mask: number,
): void {
  let color = src[srcOffset];
  const reader = new BitReader(src, srcOffset + 2);
  reader.seed(src[srcOffset + 1], 8);
  const state: ZigzagState = { inc: -1 };

  const { height, dstStride, dstOffset } = target;

  for (let x = 0; x < STRIP_WIDTH; x++) {
    let index = dstOffset + x;
    for (let y = 0; y < height; y++) {
      reader.fill();
      if (!transpCheck || color !== target.transparentColor) {
        writePixel(target, index, color);
      }
      index += dstStride;

      color = nextColor(reader, color, shift, mask, state);
    }
  }
}

/** Codecs 20-28 / 40-48: the same scheme scanned horizontally. */
function drawStripBasicH(
  src: Uint8Array,
  srcOffset: number,
  target: StripTarget,
  transpCheck: boolean,
  shift: number,
  mask: number,
): void {
  let color = src[srcOffset];
  const reader = new BitReader(src, srcOffset + 2);
  reader.seed(src[srcOffset + 1], 8);
  const state: ZigzagState = { inc: -1 };

  const { height, dstStride, dstOffset } = target;
  let row = dstOffset;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < STRIP_WIDTH; x++) {
      reader.fill();
      if (!transpCheck || color !== target.transparentColor) {
        writePixel(target, row + x, color);
      }

      color = nextColor(reader, color, shift, mask, state);
    }
    row += dstStride;
  }
}

/**
 * The major/minor bit reader used by codecs 60-128.
 *
 * Differs from `BitReader` in that it is seeded with 16 bits and reads
 * variable-width fields, so it is kept separate rather than generalised.
 */
class MajMinReader {
  private bits: number;
  private numBits = 16;
  private offset: number;
  private readonly src: Uint8Array;
  color: number;
  repeatMode = false;
  repeatCount = 0;

  constructor(src: Uint8Array, offset: number) {
    this.src = src;
    this.color = src[offset];
    this.bits = src[offset + 1] | (src[offset + 2] << 8);
    this.offset = offset + 3;
  }

  readBits(n: number): number {
    if (this.numBits <= 8) {
      this.bits |= (this.src[this.offset++] ?? 0) << this.numBits;
      this.numBits += 8;
    }
    const value = this.bits & ((1 << n) - 1);
    this.numBits -= n;
    this.bits >>>= n;
    return value;
  }
}

/**
 * Codecs 60-68 / 80-88 / 100-108 / 120-128.
 *
 * Colours change by a signed 3 bit delta in the range -4..+3. A delta of zero
 * is reused as an escape meaning "repeat the current colour N times", which is
 * what makes this family beat the plain zigzag codecs on flat artwork.
 */
function drawStripComplex(
  src: Uint8Array,
  srcOffset: number,
  target: StripTarget,
  transpCheck: boolean,
  shift: number,
): void {
  const reader = new MajMinReader(src, srcOffset);
  const line = new Uint8Array(STRIP_WIDTH);
  let row = target.dstOffset;

  for (let y = 0; y < target.height; y++) {
    decodeMajMinLine(reader, line, STRIP_WIDTH, shift);
    for (let x = 0; x < STRIP_WIDTH; x++) {
      const color = line[x];
      if (!transpCheck || color !== target.transparentColor) {
        writePixel(target, row + x, color);
      }
    }
    row += target.dstStride;
  }
}

function decodeMajMinLine(
  reader: MajMinReader,
  out: Uint8Array,
  count: number,
  shift: number,
): void {
  for (let i = 0; i < count; i++) {
    out[i] = reader.color;

    if (!reader.repeatMode) {
      if (reader.readBits(1)) {
        if (reader.readBits(1)) {
          const diff = reader.readBits(3) - 4;
          if (diff !== 0) {
            reader.color = (reader.color + diff) & 0xff;
          } else {
            reader.repeatMode = true;
            reader.repeatCount = reader.readBits(8) - 1;
          }
        } else {
          reader.color = reader.readBits(shift);
        }
      }
    } else if (--reader.repeatCount === 0) {
      reader.repeatMode = false;
    }
  }
}

/**
 * Codecs 130-138 / 140-148.
 *
 * A later variant with deltas of -4..+4 (skipping 0) and a 24 bit priming read.
 */
function drawStripMajMinWide(
  src: Uint8Array,
  srcOffset: number,
  target: StripTarget,
  transpCheck: boolean,
  shift: number,
  mask: number,
): void {
  const DELTA = [-4, -3, -2, -1, 1, 2, 3, 4];

  let color = src[srcOffset];
  let offset = srcOffset + 1;
  let data = src[offset] | (src[offset + 1] << 8) | (src[offset + 2] << 16);
  offset += 3;
  let available = 24;

  const fill = (n: number): void => {
    if (available < n) {
      data |= (src[offset++] ?? 0) << available;
      available += 8;
    }
  };
  const readBit = (): number => {
    const bit = data & 1;
    data >>>= 1;
    available--;
    return bit;
  };

  const { height, dstStride, dstOffset } = target;
  // A strip of no height has no exit condition below: `y` counts up and would
  // never equal it. Zero is what a room header this engine misreads decodes to.
  if (height <= 0) return;

  let row = dstOffset;
  let x = 0;
  let y = 0;

  for (;;) {
    if (!transpCheck || color !== target.transparentColor) {
      writePixel(target, row + x, color);
    }
    x++;
    if (x === STRIP_WIDTH) {
      x = 0;
      row += dstStride;
      y++;
      if (y >= height) return;
    }

    fill(1);
    if (readBit()) {
      fill(1);
      if (readBit()) {
        fill(3);
        color = (color + DELTA[data & 7]) & 0xff;
        available -= 3;
        data >>>= 3;
      } else {
        fill(shift);
        color = data & mask;
        available -= shift;
        data >>>= shift;
      }
    }
  }
}

/**
 * Decodes a z-plane strip: a run-length encoded 1-bit-per-pixel mask.
 *
 * A set bit means "this pixel is in front of the actor", i.e. the actor is
 * masked out there. Rows are `strideBytes` apart because the whole mask plane
 * is stored as one byte per strip per row.
 */
export function decodeMaskStrip(
  src: Uint8Array,
  srcOffset: number,
  dst: Uint8Array,
  dstOffset: number,
  strideBytes: number,
  height: number,
  orInto = false,
): void {
  let s = srcOffset;
  let d = dstOffset;
  let remaining = height;

  while (remaining > 0 && s < src.length) {
    let run = src[s++];
    if (run & 0x80) {
      run &= 0x7f;
      const value = src[s++] ?? 0;
      // Every run consumes at least one row, as in the original's do/while.
      // A `while` here would spin forever on a zero run length, which is what
      // a truncated or unexpected mask plane decodes to — a hung tab rather
      // than a wrong pixel.
      do {
        dst[d] = orInto ? dst[d] | value : value;
        d += strideBytes;
        remaining--;
      } while (--run > 0 && remaining > 0);
    } else {
      do {
        const value = src[s++] ?? 0;
        dst[d] = orInto ? dst[d] | value : value;
        d += strideBytes;
        remaining--;
      } while (--run > 0 && remaining > 0);
    }
  }
}
