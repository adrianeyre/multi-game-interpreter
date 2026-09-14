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
 * decodes cels; it does not yet run chores, whose opcode operand layouts are
 * not established here. An actor can be drawn from it; an actor cannot yet be
 * animated by it.
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

/** Codec values `AKHD` can carry. Only `CdatRle` is decoded here. */
export const AkosCodec = {
  ByteRle: 1,
  /** BOMP-encoded, unscaled. */
  CdatRle: 5,
  RunMajMin: 16,
  /** Humongous Entertainment only; not a LucasArts format. */
  Trle: 32,
} as const;

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
    decodable: costume.codec === AkosCodec.CdatRle,
  };
}

/**
 * Decodes one cel to one byte per pixel, row-major, 0 meaning transparent.
 *
 * Null for a codec this does not decode, rather than an approximation: a cel
 * decoded with the wrong codec is not a worse picture, it is noise, and noise
 * that renders looks like a rendering bug for a long time.
 */
export function decodeAkosCel(costume: AkosCostume, index: number): Uint8Array | null {
  const cel = costume.cels[index];
  if (!cel || !costume.decodable) return null;
  if (cel.width <= 0 || cel.height <= 0) return null;
  if (cel.dataOffset >= costume.celData.length) return null;

  return decodeBomp(costume.celData.subarray(cel.dataOffset), cel.width, cel.height);
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
