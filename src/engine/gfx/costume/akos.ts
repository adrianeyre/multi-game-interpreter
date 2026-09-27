import { chunkData, findChunk, readChunkHeader } from '../../resource/Chunk.js';
import { readU16LE, readU32LE } from '../../util/ByteStream.js';
import { decodeBomp } from './bomp.js';

/**
 * AKOS costumes — the v6 sprite format.
 *
 * v5 costumes are the "classic" format `Costume.ts` reads. v6 replaced it
 * wholesale, and the shape of the replacement is worth stating because it is
 * not a variation: a costume is now a set of numbered **cels** (the pictures),
 * a table of **chores** (the animations), and a small opcode language that says
 * which cels a chore draws and when. The two halves are independent — a cel can
 * be decoded and drawn with nothing known about the chore language.
 *
 * That split is why this file stops where it does. It reads the container and
 * decodes cels in each of the three LucasArts codecs; the chore language is
 * `chore.ts`'s.
 *
 * Block layout, per ScummVM's `akos.cpp` and `akos.h`:
 *
 *   AKHD   six 16-bit fields: version, flags, chore count, cel count, codec,
 *          layer count
 *   AKPL   the palette-index list; its length is the colour count
 *   RGBS   24-bit RGB triplets, for the true-colour releases
 *   AKOF   one 6-byte record per cel: uint32 offset into AKCD, uint16 into AKCI
 *   AKCI   per-cel geometry: width, height, relX, relY, moveX, moveY
 *   AKCD   the pixel data
 *   AKCH   chore offset table, one uint16 per chore, into AKCH itself
 *   AKSQ   the chore opcode stream
 */

/** Bit 0 of the costume flags: the artwork is drawn facing right. */
export const AKOS_FACES_RIGHT = 1;
/** Bit 1: eight directions rather than four. */
export const AKOS_MANY_DIRECTIONS = 2;

/**
 * Codec values `AKHD` can carry (`AKOS_*_CODEC` in ScummVM's `akos.h`).
 *
 * The three LucasArts ones are decoded here; `Trle` is not.
 */
export const AkosCodec = {
  /** Column-major byte RLE, the classic costume encoding; scales. */
  ByteRle: 1,
  /** BOMP-encoded, row-major; never scaled. */
  CdatRle: 5,
  /** A bit stream of colour deltas and repeats, row-major; never scaled. */
  RunMajMin: 16,
  /** Humongous Entertainment only; not a LucasArts format. */
  Trle: 32,
} as const;

const DECODED_CODECS: ReadonlySet<number> = new Set([
  AkosCodec.ByteRle,
  AkosCodec.CdatRle,
  AkosCodec.RunMajMin,
]);

/**
 * A decoded cel, in the form its codec gives it.
 *
 * The codecs disagree about three things at once, and a renderer has to know
 * which it is holding, so the forms are kept apart rather than normalised:
 *
 * - **`columns`** (codec 1): column-major, holding the costume's *own* colour
 *   numbers, which the actor palette then maps to the screen; 0 is
 *   transparent. Drawn through the scaling costume renderer.
 * - **`rows`** (codecs 5 and 16): row-major, holding *screen* colours, with 255
 *   transparent. Drawn through `drawBomp`, unscaled.
 */
export interface AkosCelImage {
  layout: 'columns' | 'rows';
  pixels: Uint8Array;
}

export interface AkosCel {
  width: number;
  height: number;
  /** Where the cel sits relative to the limb's running position. */
  relX: number;
  relY: number;
  /** How much the running position advances after this cel. */
  moveX: number;
  moveY: number;
  /** Offset of this cel's pixels within `AKCD`. */
  dataOffset: number;
}

export interface AkosCostume {
  version: number;
  flags: number;
  choreCount: number;
  celCount: number;
  codec: number;
  layerCount: number;
  /** Palette indices this costume's colours map through. */
  palette: Uint8Array;
  /**
   * One RGB triplet per palette entry, or empty when the costume has none.
   *
   * The true colours behind `palette`'s indices. Nothing draws from these —
   * drawing goes through the room's palette — but a script that recolours an
   * actor works from them: it scales each triplet and asks the room which of
   * its colours comes closest. Without them there is nothing to scale, and the
   * original gives up on the remap for exactly that reason.
   */
  rgbs: Uint8Array;
  cels: AkosCel[];
  /** Raw pixel data; a cel names an offset into it. */
  celData: Uint8Array;
  /** Chore offsets into the chore block, or an empty list when there are none. */
  chores: number[];
  /** The chore opcode stream a chore offset points into. */
  sequence: Uint8Array;
  /** True when this reader can decode the cels, which depends on the codec. */
  readonly decodable: boolean;
}

/** Reads an `AKOS` resource, or null when it is not one. */
export function parseAkos(data: Uint8Array): AkosCostume | null {
  const root = readChunkHeader(data, 0);
  if (root.tag !== 'AKOS') return null;

  const end = root.dataOffset + root.dataSize;
  const header = findChunk(data, root.dataOffset, 'AKHD', end);
  if (!header || header.dataSize < 12) return null;

  const at = header.dataOffset;
  const costume = {
    version: readU16LE(data, at),
    flags: readU16LE(data, at + 2),
    choreCount: readU16LE(data, at + 4),
    celCount: readU16LE(data, at + 6),
    codec: readU16LE(data, at + 8),
    layerCount: readU16LE(data, at + 10),
  };

  const paletteChunk = findChunk(data, root.dataOffset, 'AKPL', end);
  const rgbsChunk = findChunk(data, root.dataOffset, 'RGBS', end);
  const offsets = findChunk(data, root.dataOffset, 'AKOF', end);
  const info = findChunk(data, root.dataOffset, 'AKCI', end);
  const celData = findChunk(data, root.dataOffset, 'AKCD', end);
  const choreTable = findChunk(data, root.dataOffset, 'AKCH', end);
  const sequence = findChunk(data, root.dataOffset, 'AKSQ', end);

  const cels: AkosCel[] = [];
  if (offsets && info) {
    // Six bytes per record, and the two halves address different blocks: the
    // 32-bit value indexes the pixels, the 16-bit one the geometry. Reading
    // them as one array of anything uniform gets both wrong.
    const count = Math.min(costume.celCount, Math.floor(offsets.dataSize / 6));
    for (let i = 0; i < count; i++) {
      const record = offsets.dataOffset + i * 6;
      const dataOffset = readU32LE(data, record);
      const infoAt = info.dataOffset + readU16LE(data, record + 4);
      if (infoAt + 12 > end) continue;

      cels.push({
        width: readU16LE(data, infoAt),
        height: readU16LE(data, infoAt + 2),
        relX: signed16(readU16LE(data, infoAt + 4)),
        relY: signed16(readU16LE(data, infoAt + 6)),
        moveX: signed16(readU16LE(data, infoAt + 8)),
        moveY: signed16(readU16LE(data, infoAt + 10)),
        dataOffset,
      });
    }
  }

  const chores: number[] = [];
  if (choreTable) {
    const count = Math.min(costume.choreCount, Math.floor(choreTable.dataSize / 2));
    for (let i = 0; i < count; i++) {
      chores.push(readU16LE(data, choreTable.dataOffset + i * 2));
    }
  }

  return {
    ...costume,
    palette: paletteChunk ? chunkData(data, paletteChunk) : new Uint8Array(0),
    rgbs: rgbsChunk ? chunkData(data, rgbsChunk) : new Uint8Array(0),
    cels,
    celData: celData ? chunkData(data, celData) : new Uint8Array(0),
    chores,
    sequence: sequence ? chunkData(data, sequence) : new Uint8Array(0),
    decodable: DECODED_CODECS.has(costume.codec),
  };
}

/**
 * Decodes one cel, or null when it cannot be.
 *
 * Null for a codec this does not decode, rather than an approximation: a cel
 * decoded with the wrong codec is not a worse picture, it is noise, and noise
 * that renders looks like a rendering bug for a long time.
 */
export function decodeAkosCel(costume: AkosCostume, index: number): AkosCelImage | null {
  const cel = costume.cels[index];
  if (!cel || !costume.decodable) return null;
  if (cel.width <= 0 || cel.height <= 0) return null;
  if (cel.dataOffset >= costume.celData.length) return null;

  const source = costume.celData.subarray(cel.dataOffset);
  switch (costume.codec) {
    case AkosCodec.ByteRle:
      return {
        layout: 'columns',
        pixels: decodeByleRle(source, cel.width, cel.height, costume.palette.length),
      };
    case AkosCodec.CdatRle:
      // Zeros written: 0 is a colour in this codec, 255 the transparent one.
      return { layout: 'rows', pixels: decodeBomp(source, cel.width, cel.height, true) };
    case AkosCodec.RunMajMin:
      return { layout: 'rows', pixels: decodeMajMin(source, cel.width, cel.height) };
    default:
      return null;
  }
}

/**
 * Codec 1: the byte RLE classic costumes use, column by column.
 *
 * Each byte is a colour in its top bits and a run length in the rest, with a
 * zero length meaning the next byte holds it. How the byte splits depends on
 * how many colours the costume has — the same rule as the classic format,
 * read here off the `AKPL`'s length (`paintCelByleRLECommon`: 32 colours give
 * three bits of length, 64 give two, anything else four).
 *
 * A length byte of zero is a run of 256, not an end: the reference counts it
 * down as a byte from zero.
 */
export function decodeByleRle(
  source: Uint8Array,
  width: number,
  height: number,
  numColors: number,
): Uint8Array {
  const shift = numColors === 32 ? 3 : numColors === 64 ? 2 : 4;
  const mask = (1 << shift) - 1;
  const total = width * height;
  const out = new Uint8Array(total);

  let read = 0;
  let write = 0;
  while (write < total && read < source.length) {
    const code = source[read++];
    const colour = code >> shift;
    let length = code & mask;
    if (length === 0) length = source[read++] ?? 0;
    if (length === 0) length = 256;

    const end = Math.min(total, write + length);
    out.fill(colour, write, end);
    write = end;
  }
  return out;
}

/**
 * Codec 16, "run major/minor": a bit stream of small colour changes.
 *
 * The stream opens with the width in bits of an absolute colour, then the
 * first colour, then the first sixteen bits of the stream. For each pixel the
 * current colour is written *first* and the stream then says what the next
 * one is: a 0 bit keeps it; `1 0` reads an absolute colour; `1 1` reads three
 * bits as a change of -4..3, where a change of 0 instead reads an eight-bit
 * count of pixels to repeat without consulting the stream. Bits are taken
 * least significant first. (`MajMinCodec` in ScummVM's `gfx.cpp`.)
 *
 * The stream runs across line ends without a break, so the whole cel is
 * decoded in reading order. The reference skips the clipped part of the
 * stream rather than drawing it, which comes to the same pixels.
 *
 * A repeat count of 0 or 1 takes the reference's counter below zero, after
 * which it never counts back down to the end of the repeat; that is kept, so
 * the rest of such a cel is the one colour.
 */
export function decodeMajMin(source: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  if (source.length < 4) return out.fill(255);

  const shift = source[0];
  let colour = source[1];
  let bits = source[2] | (source[3] << 8);
  let numBits = 16;
  let read = 4;

  const readBits = (n: number): number => {
    if (numBits <= 8) {
      bits = (bits | ((source[read++] ?? 0) << numBits)) & 0xffff;
      numBits += 8;
    }
    const value = bits & ((1 << n) - 1);
    numBits -= n;
    bits >>= n;
    return value;
  };

  let repeating = false;
  let repeatCount = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] = colour;
    if (repeating) {
      if (--repeatCount === 0) repeating = false;
    } else if (readBits(1)) {
      if (readBits(1)) {
        const change = (readBits(3) - 4) & 0xff;
        if (change) {
          colour = (colour + change) & 0xff;
        } else {
          repeating = true;
          repeatCount = readBits(8) - 1;
        }
      } else {
        colour = readBits(shift);
      }
    }
  }
  return out;
}

/**
 * Which chore plays an animation in a given direction.
 *
 * Eight-direction costumes lay their chores out in groups of eight and
 * four-direction ones in groups of four, so the same frame number means a
 * different chore in each. Getting the stride wrong selects a real chore
 * belonging to another animation, which plays something plausible and wrong.
 */
export function choreFor(costume: AkosCostume, frame: number, direction: number): number {
  const stride = costume.flags & AKOS_MANY_DIRECTIONS ? 8 : 4;
  return (((direction % stride) + stride) % stride) + frame * stride;
}

function signed16(value: number): number {
  return value & 0x8000 ? value - 0x10000 : value;
}
