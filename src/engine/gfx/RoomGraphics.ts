import { readU16LE, readU32LE, readU32BE } from '../util/ByteStream.js';
import {
  SMALL_CHUNK_HEADER_SIZE,
  findChunk,
  findChunkDeep,
  iterateChunks,
  readChunkHeader,
  readSmallChunkHeader,
} from '../resource/Chunk.js';
import { decodeEgaStrip, decodeMaskStrip, decodeStrip } from './BitmapCodec.js';

const STRIP_WIDTH = 8;
const MAX_Z_PLANES = 4;

/**
 * The decoded pixels of one room: the background plus its z-planes.
 *
 * SCUMM redraws only the strips it dirties, because a 386 could not afford to
 * touch 64000 bytes per frame. This decodes the whole room once into a
 * room-sized buffer and composites a window of it every frame, which is both
 * simpler and comfortably fast in a browser — and it means objects can be
 * stamped into the background exactly as the original did.
 */
export class RoomGraphics {
  readonly width: number;
  readonly height: number;
  readonly strips: number;

  /** Palette indices, `width * height`. */
  readonly background: Uint8Array;

  /**
   * Z-planes, one bit per pixel, `strips * height` bytes each.
   *
   * A set bit means the background occludes anything drawn at that pixel, so
   * an actor standing "behind" a pillar is clipped by it.
   */
  readonly zPlanes: Uint8Array[] = [];

  readonly transparentColor: number;

  constructor(width: number, height: number, numZPlanes: number, transparentColor = 255) {
    this.width = width;
    this.height = height;
    this.strips = Math.ceil(width / STRIP_WIDTH);
    this.background = new Uint8Array(width * height);
    this.transparentColor = transparentColor;
    for (let i = 0; i < Math.min(numZPlanes, MAX_Z_PLANES); i++) {
      this.zPlanes.push(new Uint8Array(this.strips * height));
    }
  }

  /** True if any z-plane at or above `plane` occludes the pixel. */
  /**
   * Whether z-plane `plane` hides the pixel at (x, y).
   *
   * *That* plane, and no other. An actor is drawn against the single mask its
   * walk box names (`getMaskFromBox` picks one, and the renderer reads
   * `getMaskBuffer(..., _zbuf)`), so testing every plane above it as well
   * makes the room's foreground layers occlude an actor that is standing in
   * front of them: Indy walks past a doorway and the wall beside it draws over
   * him. Plane 0 is "not masked at all".
   */
  isMasked(plane: number, x: number, y: number): boolean {
    if (plane <= 0) return false;
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    const mask = this.zPlanes[plane - 1];
    if (!mask) return false;
    return (mask[y * this.strips + (x >> 3)] & (0x80 >> (x & 7))) !== 0;
  }

  /**
   * Decodes an image block (`IM00` for the room, `IMxx` for an object).
   *
   * @param destX destination in room coordinates; objects are placed by their
   *              CDHD position, the room background at the origin
   * @param clearZ whether to overwrite the z-planes (room) or OR into them
   *               (objects, which add occlusion rather than replacing it)
   */
  decodeImage(
    data: Uint8Array,
    imageOffset: number,
    destX: number,
    destY: number,
    imageWidth: number,
    imageHeight: number,
    clearZ: boolean,
  ): void {
    const image = readChunkHeader(data, imageOffset);
    const imageEnd = image.dataOffset + image.dataSize;

    // v5 to v7 wrap the strip table in `IM00` (and a room's in `RMIM` above
    // that), so the block here is a container and the `SMAP` is inside it. v8
    // addresses the strip table directly out of its `OFFS` table, so the block
    // here *is* the `SMAP` — and searching inside a `SMAP` for a `SMAP` finds
    // nothing, which draws a room with no floor rather than failing.
    const smap =
      image.tag === 'SMAP' ? image : findChunkDeep(data, image.dataOffset, 'SMAP', imageEnd, 2);
    if (!smap) return;

    const numStrips = Math.ceil(imageWidth / STRIP_WIDTH);
    const smapLen = readU32BE(data, smap.offset + 4);

    for (let strip = 0; strip < numStrips; strip++) {
      const tableOffset = strip * 4 + 8;
      if (tableOffset + 4 > smapLen) break;
      const stripOffset = readU32LE(data, smap.offset + tableOffset);
      if (stripOffset <= 0 || smap.offset + stripOffset >= data.length) continue;

      const x = destX + strip * STRIP_WIDTH;
      if (x + STRIP_WIDTH <= 0 || x >= this.width) continue;

      // Decode into a scratch column first so partially off-room strips can be
      // clipped without the codecs needing to know about clipping.
      //
      // Seeded with what is already there, because a transparent codec says
      // "leave the destination alone" by *not writing* — so an untouched
      // scratch byte has to already hold the destination's pixel. Starting the
      // scratch at zero and blitting it whole painted colour 0 over every
      // transparent pixel instead: every object image in the game arrived
      // inside a black rectangle, which is the one thing a transparent codec
      // exists to prevent. Atlantis's title card is the clearest single case:
      // an object whose image is a few words on transparent pixels, drawn as a
      // black box with the words inside it.
      const scratch = new Uint8Array(STRIP_WIDTH * imageHeight);
      this.readStrip(scratch, x, destY, imageHeight);
      decodeStrip(data, smap.offset + stripOffset, {
        dst: scratch,
        dstOffset: 0,
        dstStride: STRIP_WIDTH,
        height: imageHeight,
        transparentColor: this.transparentColor,
      });

      this.blitStrip(scratch, x, destY, imageHeight);
    }

    this.decodeZPlanes(data, image, imageEnd, destX, destY, numStrips, imageHeight, clearZ);
  }

  /**
   * A v2-v4 image: the `BM` block, whose strip table it carries itself.
   *
   * v5 keeps its strips behind a `SMAP` chunk with an eight byte header and a
   * table of 32-bit offsets counted from the chunk's own start. v4 has neither
   * the chunk nor the header: the block's payload *is* the table, its first
   * field is the payload's own length, and the offsets that follow are counted
   * from there. A sixteen-colour release narrows both to sixteen bits, which
   * halves the stride and moves the first entry — read one as the other and
   * every strip after the first lands somewhere arbitrary.
   *
   * The strips themselves are the divergence that matters. A 256-colour v4
   * release uses the same codec family v5 does, code byte and all, so it goes
   * through `decodeStrip` unchanged. A sixteen-colour one uses a scheme with
   * no code byte at all (`decodeEgaStrip`), and nothing in the block says
   * which — the Version and the release do, which is why it is a parameter
   * here rather than a sniff.
   */
  decodeSmallImage(
    data: Uint8Array,
    /**
     * The strip table's own first byte, not the block's.
     *
     * The two differ by block: a room's `BM` puts the table straight after its
     * six byte header, and an object's `OI` puts the object's id in between.
     * Asking the caller for the table rather than the block keeps that
     * knowledge where the tags are read and out of the decoder.
     */
    table: number,
    destX: number,
    destY: number,
    imageWidth: number,
    imageHeight: number,
    sixteenColour: boolean,
  ): void {
    if (table >= data.length) return;

    const entryBytes = sixteenColour ? 2 : 4;
    const tableLength = sixteenColour ? readU16LE(data, table) : readU32LE(data, table);
    const numStrips = Math.ceil(imageWidth / STRIP_WIDTH);

    for (let strip = 0; strip < numStrips; strip++) {
      const entry = strip * entryBytes + entryBytes;
      if (entry + entryBytes > tableLength) break;
      const stripOffset = sixteenColour
        ? readU16LE(data, table + entry)
        : readU32LE(data, table + entry);
      if (stripOffset <= 0 || table + stripOffset >= data.length) continue;

      const x = destX + strip * STRIP_WIDTH;
      if (x + STRIP_WIDTH <= 0 || x >= this.width) continue;

      const scratch = new Uint8Array(STRIP_WIDTH * imageHeight);
      this.readStrip(scratch, x, destY, imageHeight);
      const target = {
        dst: scratch,
        dstOffset: 0,
        dstStride: STRIP_WIDTH,
        height: imageHeight,
        transparentColor: this.transparentColor,
      };
      if (sixteenColour) decodeEgaStrip(data, table + stripOffset, target);
      else decodeStrip(data, table + stripOffset, target);

      this.blitStrip(scratch, x, destY, imageHeight);
    }
  }

  /** Copies the destination under a strip into `scratch`, clipped as it goes. */
  private readStrip(scratch: Uint8Array, x: number, y: number, height: number): void {
    for (let row = 0; row < height; row++) {
      const destRow = y + row;
      if (destRow < 0 || destRow >= this.height) continue;
      const destBase = destRow * this.width;
      const srcBase = row * STRIP_WIDTH;
      for (let column = 0; column < STRIP_WIDTH; column++) {
        const destX = x + column;
        if (destX < 0 || destX >= this.width) continue;
        scratch[srcBase + column] = this.background[destBase + destX];
      }
    }
  }

  private blitStrip(scratch: Uint8Array, x: number, y: number, height: number): void {
    for (let row = 0; row < height; row++) {
      const destRow = y + row;
      if (destRow < 0 || destRow >= this.height) continue;
      const destBase = destRow * this.width;
      const srcBase = row * STRIP_WIDTH;
      for (let column = 0; column < STRIP_WIDTH; column++) {
        const destX = x + column;
        if (destX < 0 || destX >= this.width) continue;
        this.background[destBase + destX] = scratch[srcBase + column];
      }
    }
  }

  /**
   * Reads the ZP01..ZP04 sub-chunks that accompany an image.
   *
   * Note the offset table here is 16 bit, unlike SMAP's 32 bit table.
   */
  private decodeZPlanes(
    data: Uint8Array,
    image: { dataOffset: number; dataSize: number },
    imageEnd: number,
    destX: number,
    destY: number,
    numStrips: number,
    imageHeight: number,
    clearZ: boolean,
  ): void {
    for (let plane = 0; plane < this.zPlanes.length; plane++) {
      const tag = `ZP${String(plane + 1).padStart(2, '0')}`;
      const zp =
        findChunk(data, image.dataOffset, tag, imageEnd) ??
        findChunkDeep(data, image.dataOffset, tag, imageEnd, 2);
      const target = this.zPlanes[plane];

      if (clearZ && destX === 0 && destY === 0 && !zp) {
        target.fill(0);
        continue;
      }
      if (!zp) continue;

      const stripBase = destX >> 3;
      for (let strip = 0; strip < numStrips; strip++) {
        const destStrip = stripBase + strip;
        if (destStrip < 0 || destStrip >= this.strips) continue;

        const tableOffset = zp.offset + strip * 2 + 8;
        if (tableOffset + 2 > zp.offset + zp.size) break;
        const stripOffset = readU16LE(data, tableOffset);
        if (stripOffset === 0) continue;

        // Clipping vertically is done by decoding into a scratch column.
        const scratch = new Uint8Array(imageHeight);
        decodeMaskStrip(data, zp.offset + stripOffset, scratch, 0, 1, imageHeight, false);

        for (let row = 0; row < imageHeight; row++) {
          const destRow = destY + row;
          if (destRow < 0 || destRow >= this.height) continue;
          const index = destRow * this.strips + destStrip;
          target[index] = clearZ ? scratch[row] : target[index] | scratch[row];
        }
      }
    }
  }

  /** Clears an object's z-plane contribution when the object is hidden. */
  clearZPlaneRegion(x: number, y: number, width: number, height: number): void {
    const startStrip = Math.max(0, x >> 3);
    const endStrip = Math.min(this.strips, Math.ceil((x + width) / STRIP_WIDTH));
    for (const plane of this.zPlanes) {
      for (let row = y; row < y + height; row++) {
        if (row < 0 || row >= this.height) continue;
        plane.fill(0, row * this.strips + startStrip, row * this.strips + endStrip);
      }
    }
  }
}

/** Finds an image chunk (`IM01`, `IM02`, ...) for a given object state. */
export function findObjectImage(
  data: Uint8Array,
  obimOffset: number,
  state: number,
  /**
   * True for v2-v4, whose object image is not a chunk at all.
   *
   * An `OI` block is a six byte header, the object's id as a word, and then
   * the picture — one picture, with no `IMHD` in front of it and no `IMxx`
   * around it. Searching it for a v5 image chunk finds either nothing or, worse,
   * two bytes of the picture that happen to read as a tag.
   */
  small = false,
): number | null {
  if (small) {
    const block = readSmallChunkHeader(data, obimOffset);
    return block.tag === 'OI' ? obimOffset + SMALL_CHUNK_HEADER_SIZE + 2 : null;
  }

  const obim = readChunkHeader(data, obimOffset);
  const wanted = `IM${String(Math.max(1, state)).padStart(2, '0')}`;
  const end = obim.dataOffset + obim.dataSize;

  const exact = findChunk(data, obim.dataOffset, wanted, end);
  if (exact) return exact.offset;

  // Some objects only ship one image and rely on state purely for logic.
  for (const chunk of iterateChunks(data, obim.dataOffset, end)) {
    if (isImageStateTag(chunk.tag)) return chunk.offset;
  }
  return null;
}

/**
 * Whether a chunk inside an OBIM is one of the object's images.
 *
 * IM01, IM02 and so on are; IMHD is the header in front of them and starts
 * with the same two letters. Reading it as an image decoded the header's bytes
 * as pixels — which is what the fallback above did for any object asked for a
 * state it does not ship, so a door in state 2 with one drawing got the header
 * rather than the drawing.
 */
export function isImageStateTag(tag: string): boolean {
  return /^IM\d\d$/.test(tag) && tag !== 'IM00';
}
