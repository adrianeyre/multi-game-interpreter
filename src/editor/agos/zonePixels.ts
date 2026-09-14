/**
 * Turning a zone's bytes into a picture.
 *
 * Small, and separate from the surface, because the surface is not allowed to
 * have an opinion here: the same entry reader and the same two sprite decoders
 * the engine uses, so a canvas cannot disagree with the screen about what an
 * image looks like.
 */

import {
  decodeCompressedSprite,
  decodeSprite,
  isCompressedEntry,
  type IndexedBitmap,
} from '../../engine/agos/gfx/agosImage.js';
import { readVgaImageEntry } from '../../engine/agos/gfx/vgaImages.js';

/**
 * A zone's pixel resource, by zone number.
 *
 * Undefined for a zone this reader has no bytes for, which is different from a
 * zone that holds nothing: the first is a folder that was never offered and the
 * second is a game with an empty zone, and the surface says different things
 * about them.
 */
export type ZoneReader = (zone: number) => Uint8Array | undefined;

/** One image out of a zone's bytes. Throws with a reason a person can read. */
export function decodeZoneImage(pixels: Uint8Array, id: number): IndexedBitmap {
  const entry = readVgaImageEntry(pixels, id);
  if (!entry) throw new Error(`this zone has no image ${id}`);

  // The entry's own rule, which is the renderer's — see `isCompressedEntry`.
  // Testing the script's `compressed` flag here instead is what made every one
  // of Simon 1's images decode as noise and show as a black rectangle.
  const compressed = isCompressedEntry(entry.flags);
  const source = compressed
    ? pixels.subarray(entry.offset)
    : pixels.subarray(entry.offset, entry.offset + entry.widthBytes * entry.height);

  return compressed
    ? decodeCompressedSprite(source, entry.widthBytes, entry.height, { opaque: true })
    : decodeSprite(source, entry.widthBytes, entry.height, { opaque: true });
}

/**
 * Why a zone's pixels are not available, or null when they are.
 *
 * A sentence rather than a boolean, because the two reasons lead to different
 * next steps: no reader at all means the game folder has not been offered
 * (ADR 0034), and a reader that answers nothing for this zone means the folder
 * is open and that zone is not in it.
 */
export function describeZoneAccess(read: ZoneReader | undefined, zone: number): string | null {
  if (!read) {
    return (
      'The pixels of an AGOS image are not in the project — they live in the game’s ' +
      'resource archive, which is far too large to keep a second copy of in the browser ' +
      '(ADR 0010). Open the game folder to draw them.'
    );
  }
  if (!read(zone)) return `Zone ${zone}’s pixels could not be read out of that folder.`;
  return null;
}
