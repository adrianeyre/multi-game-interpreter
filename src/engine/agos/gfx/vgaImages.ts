/**
 * Where an image's pixels are, and how big it is.
 *
 * A graphics zone ships as **two** resources: the one `vgaFile.ts` reads, which
 * holds the tables and the VGA scripts, and this one, which holds pixels. An
 * eight-byte entry per image, indexed by the image number a script names — so a
 * `DRAW 12` in a script means "entry 12 of the pixel resource", and nothing has
 * to be searched for.
 *
 * ## The width word is the width in pixels
 *
 * That is worth stating flatly because the arithmetic around it invites a wrong
 * answer, and this file used to give one. The reference divides the stored word
 * by sixteen and calls the result `width`; then `drawImage_clip` doubles it and
 * quadruples it, and the drawing loop writes two pixels per unit. Sixteen out,
 * sixteen back in — **the stored word is the pixel width**, and a byte of
 * source holds two pixels, so a row is half that many bytes.
 *
 * Reading the stored word as the *byte* width, which is what dividing by
 * sixteen and stopping there does, makes every sprite an eighth of its real
 * width. On Simon 1's title screen that looked like the right picture cut into
 * forty-pixel ribbons — recognisable enough to suggest the decoder was nearly
 * right, when the fault was three lines up in the arithmetic.
 */

export interface VgaImageEntry {
  /** Where the pixels start, as an offset into the pixel resource. */
  readonly offset: number;
  /** Width in bytes, the format's own unit: two pixels each. */
  readonly widthBytes: number;
  /** Width in pixels, which is what a caller almost always wants. */
  readonly width: number;
  readonly height: number;
  readonly flags: number;
}

/** Draw flags, as the scripts set them. */
export const DRAW_FLAGS = {
  flip: 0x1,
  /** Colour zero is drawn rather than treated as transparent. */
  opaque: 0x2,
  skipStoreBackground: 0x4,
  compressed: 0x8,
  compressedFlip: 0x10,
  masked: 0x20,
} as const;

/** A big-endian 32-bit word, the unit Simon 2's column-offset tables are in. */
export function readU32BE(data: Uint8Array, at: number): number {
  return (
    (data[at] ?? 0) * 0x1000000 +
    (data[at + 1] ?? 0) * 0x10000 +
    (data[at + 2] ?? 0) * 0x100 +
    (data[at + 3] ?? 0)
  );
}

function readU16BE(data: Uint8Array, at: number): number {
  return ((data[at] ?? 0) << 8) | (data[at + 1] ?? 0);
}

function readU16LE(data: Uint8Array, at: number): number {
  return (data[at] ?? 0) | ((data[at + 1] ?? 0) << 8);
}

/**
 * Reads one image's entry.
 *
 * Image 0 is not an image: scripts use it to mean "nothing", and the reference
 * returns early on it rather than reading an entry. Returning `null` here says
 * the same thing in a way a caller cannot accidentally draw.
 */
export function readVgaImageEntry(
  pixels: Uint8Array,
  image: number,
  options: { agos2?: boolean } = {},
): VgaImageEntry | null {
  if (image === 0) return null;
  const at = image * 8;
  if (at + 8 > pixels.length) {
    throw new Error(`image ${image} has no entry: the pixel resource is ${pixels.length} bytes`);
  }

  if (options.agos2) {
    const widthBytes = readU16LE(pixels, at + 6);
    return {
      offset: readU32BE(pixels, at),
      widthBytes,
      width: widthBytes,
      height: readU16LE(pixels, at + 4) & 0x7fff,
      flags: pixels[at + 5] ?? 0,
    };
  }

  // The stored word is the pixel width; a byte holds two pixels.
  const width = readU16BE(pixels, at + 6);
  return {
    offset: readU32BE(pixels, at),
    widthBytes: width / 2,
    width,
    height: pixels[at + 5] ?? 0,
    flags: pixels[at + 4] ?? 0,
  };
}
