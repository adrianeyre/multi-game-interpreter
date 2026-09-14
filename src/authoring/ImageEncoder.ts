import { chunk, u16le, u32le, type Bytes } from './encode.js';

const STRIP_WIDTH = 8;

/** An image as palette indices, row-major. */
export interface IndexedImage {
  width: number;
  height: number;
  /** `width * height` palette indices. */
  pixels: Uint8Array;
}

export function createImage(width: number, height: number, fill = 0): IndexedImage {
  return { width, height, pixels: new Uint8Array(width * height).fill(fill) };
}

/** The palette index treated as "see through" by the transparent codec. */
export const TRANSPARENT_INDEX = 255;

export interface SmapOptions {
  /**
   * Writes codec 149 instead of codec 1, so pixels equal to
   * `TRANSPARENT_INDEX` leave the background showing.
   *
   * Room backgrounds want codec 1: they are the bottom layer, and a stray
   * transparent pixel there would show black. Object images want 149, or every
   * object is an opaque rectangle.
   */
  transparent?: boolean;
}

/**
 * Encodes an image as an `SMAP`.
 *
 * Uncompressed pixels throughout. The engine reads every codec, but only one
 * needs writing: the compressed variants exist to fit a game on floppies, and
 * an authored game has no such constraint. A 320x144 room costs 46 KB, which is
 * nothing to fetch over HTTP and saves an encoder whose bugs would be invisible
 * until a specific strip rendered wrong.
 */
export function encodeSmap(image: IndexedImage, options: SmapOptions = {}): number[] {
  const strips = Math.ceil(image.width / STRIP_WIDTH);
  const stripPayloads: number[][] = [];

  for (let strip = 0; strip < strips; strip++) {
    // Codec 1 is raw pixels; 149 is raw pixels with a transparent index.
    const payload: number[] = [options.transparent ? 149 : 1];
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < STRIP_WIDTH; x++) {
        const sourceX = strip * STRIP_WIDTH + x;
        payload.push(sourceX < image.width ? image.pixels[y * image.width + sourceX] : 0);
      }
    }
    stripPayloads.push(payload);
  }

  // Offsets are measured from the start of the chunk, and the table sits
  // immediately after the 8 byte header.
  const tableSize = strips * 4;
  let cursor = 8 + tableSize;
  const table: number[] = [];
  for (const payload of stripPayloads) {
    table.push(...u32le(cursor));
    cursor += payload.length;
  }

  return chunk('SMAP', [...table, ...stripPayloads.flat()]);
}

/**
 * Encodes a 1-bit occlusion mask as a `ZPnn` chunk.
 *
 * A set bit means the background is in front of anything drawn there, which is
 * how an authored room gets a pillar an actor can walk behind.
 */
/**
 * Encodes an image as a pre-v5 `BM` strip table and its strips.
 *
 * The v4 counterpart of `encodeSmap`, and it is a different shape rather than
 * a variation: there is no `SMAP` chunk, no eight byte header and no big-endian
 * size. The block's payload *is* the table — its own length first, then one
 * offset per strip counted from that length's first byte — and a sixteen-colour
 * release narrows every entry from thirty-two bits to sixteen.
 *
 * **Correct, not identical.** `CONTEXT.md` makes byte-identity a property of
 * resources nobody touched, and unedited art is copied rather than re-encoded,
 * so this never has to reproduce Lucasfilm's compressor. What it has to be is
 * something the game's own reader decodes to the pixels it was given — which is
 * why every strip is written with the run form and no attempt is made at the
 * dithered one. A dither that packed two colours into a run the decoder then
 * alternated would save bytes and cost a fault class nobody can see: the
 * picture would be the right shape, the right size, and visibly striped.
 */
export function encodeSmallImage(image: IndexedImage, sixteenColour: boolean): number[] {
  const strips = Math.ceil(image.width / STRIP_WIDTH);
  const bodies: number[][] = [];

  for (let strip = 0; strip < strips; strip++) {
    bodies.push(sixteenColour ? encodeEgaStrip(image, strip) : encodeRawStrip(image, strip));
  }

  const entryBytes = sixteenColour ? 2 : 4;
  const tableBytes = entryBytes * (strips + 1);
  const offsets: number[] = [];
  let at = tableBytes;
  for (const body of bodies) {
    offsets.push(at);
    at += body.length;
  }

  const out: number[] = [];
  const push = (value: number): void => {
    out.push(...(sixteenColour ? u16le(value) : u32le(value)));
  };
  // The first field is the payload's own length, which is what the reader
  // bounds the table with.
  push(at);
  for (const offset of offsets) push(offset);
  for (const body of bodies) out.push(...body);
  return out;
}

/**
 * One 256-colour strip, as codec 1: a code byte and then raw pixels.
 *
 * The same choice `encodeSmap` makes and for the same reason — the compressed
 * variants exist to fit a game on floppies, and an authored edit has no such
 * constraint.
 */
function encodeRawStrip(image: IndexedImage, strip: number): number[] {
  const out: number[] = [1];
  for (let y = 0; y < image.height; y++) {
    for (let column = 0; column < STRIP_WIDTH; column++) {
      const x = strip * STRIP_WIDTH + column;
      out.push(x < image.width ? image.pixels[y * image.width + x] : 0);
    }
  }
  return out;
}

/**
 * One sixteen-colour strip, in the EGA run form.
 *
 * The scheme scans *down each column* rather than across, which is the part
 * that makes it not a variation on anything else here: a run continues from the
 * bottom of one column into the top of the next. So the pixels are gathered in
 * that order first and run-length encoded as one sequence, rather than a row at
 * a time.
 *
 * Two run forms are written. A colour run is `length << 4 | colour` where the
 * length fits in a nibble, and `0x0 | colour` followed by a length byte where
 * it does not. The copy-left and dither forms are read and never written: both
 * save bytes and neither is needed, and the dither form in particular is one
 * whose mistakes are invisible in a histogram.
 */
function encodeEgaStrip(image: IndexedImage, strip: number): number[] {
  const column: number[] = [];
  for (let x = 0; x < STRIP_WIDTH; x++) {
    const px = strip * STRIP_WIDTH + x;
    for (let y = 0; y < image.height; y++) {
      column.push(px < image.width ? image.pixels[y * image.width + px] & 0x0f : 0);
    }
  }

  const out: number[] = [];
  let at = 0;
  while (at < column.length) {
    const colour = column[at];
    let run = 1;
    // 255 is the longest a length byte can carry.
    while (at + run < column.length && column[at + run] === colour && run < 255) run++;

    if (run < 16) {
      out.push((run << 4) | colour);
    } else {
      out.push(colour);
      out.push(run);
    }
    at += run;
  }
  return out;
}

export function encodeZPlane(
  planeNumber: number,
  mask: Uint8Array,
  width: number,
  height: number,
): number[] {
  const strips = Math.ceil(width / STRIP_WIDTH);
  const stripPayloads: number[][] = [];

  for (let strip = 0; strip < strips; strip++) {
    // One byte per row: the eight pixels of this strip.
    const column: number[] = [];
    for (let y = 0; y < height; y++) {
      let byte = 0;
      for (let bit = 0; bit < STRIP_WIDTH; bit++) {
        const x = strip * STRIP_WIDTH + bit;
        if (x < width && mask[y * width + x]) byte |= 0x80 >> bit;
      }
      column.push(byte);
    }
    stripPayloads.push(runLengthEncodeMask(column));
  }

  // The z-plane offset table is 16 bit, unlike SMAP's 32 bit one.
  const tableSize = strips * 2;
  let cursor = 8 + tableSize;
  const table: number[] = [];
  for (const payload of stripPayloads) {
    table.push(...u16le(cursor));
    cursor += payload.length;
  }

  const tag = `ZP${String(planeNumber).padStart(2, '0')}`;
  return chunk(tag, [...table, ...stripPayloads.flat()]);
}

/**
 * Run-length encodes a mask column.
 *
 * Format: a count byte, with bit 7 set meaning "the next byte repeats `count`
 * times" and clear meaning "`count` literal bytes follow". Runs are capped at
 * 127 because bit 7 is the flag.
 */
function runLengthEncodeMask(column: number[]): number[] {
  const out: number[] = [];
  let index = 0;

  while (index < column.length) {
    let runLength = 1;
    while (
      index + runLength < column.length &&
      column[index + runLength] === column[index] &&
      runLength < 127
    ) {
      runLength++;
    }

    if (runLength > 1) {
      out.push(0x80 | runLength, column[index]);
      index += runLength;
      continue;
    }

    // Gather literals until a run of two or more appears.
    let literalEnd = index;
    while (
      literalEnd < column.length &&
      literalEnd - index < 127 &&
      !(literalEnd + 1 < column.length && column[literalEnd + 1] === column[literalEnd])
    ) {
      literalEnd++;
    }
    if (literalEnd === index) literalEnd = index + 1;

    out.push(literalEnd - index, ...column.slice(index, literalEnd));
    index = literalEnd;
  }

  return out;
}

/** A room background: the `RMIM` wrapper around `IM00` and its z-planes. */
export function encodeRoomImage(image: IndexedImage, zPlanes: Uint8Array[]): number[] {
  const planes = zPlanes.map((mask, index) =>
    encodeZPlane(index + 1, mask, image.width, image.height),
  );

  return chunk('RMIM', [
    ...chunk('RMIH', u16le(zPlanes.length)),
    ...chunk('IM00', [...encodeSmap(image), ...planes.flat()]),
  ]);
}

/** An object's appearance: one `IMxx` per state. */
/**
 * Encodes an object's states, one `IMxx` each.
 *
 * Transparent, because objects are stamped over the room background and a lamp
 * should be a lamp rather than a rectangle of wall colour around a lamp.
 */
export function encodeObjectImages(images: IndexedImage[]): number[][] {
  return images.map((image, index) =>
    chunk(`IM${String(index + 1).padStart(2, '0')}`, encodeSmap(image, { transparent: true })),
  );
}

export type { Bytes };
