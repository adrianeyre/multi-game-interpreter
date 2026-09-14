/**
 * Writing an edited image back into its zone.
 *
 * The last mechanical piece of the paint path. `encodeSprite` packs a bitmap
 * into the uncompressed sprite form and `readVgaImageEntry` says where an
 * image's pixels sit; this puts the two together and produces the zone's bytes
 * with one image replaced.
 *
 * ## A new array, never a write in place
 *
 * The zone's bytes belong to the loaded game, and the rest of the Engine is
 * reading them — the VGA machine draws straight out of this resource. Mutating
 * it would change what is on screen underneath a script mid-run, and would
 * also make an edit impossible to abandon. So this copies, which is the same
 * choice `edits.ts` makes for `GAMEPC` and for the same reason.
 *
 * ## This is the right operation and the wrong *channel*
 *
 * **ADR 0030 already decided how an AGOS edit reaches a file, and it is not
 * this.** Its Consequences say an AGOS Project "holds intent and asks for the
 * game folder again at export", following ADR 0010's re-supply path, because a
 * talkie release with its speech is far above the size at which keeping the
 * originals in IndexedDB stops being reliable. A zone's pixel resource is
 * exactly that kind of payload.
 *
 * So the function below is sound — packing a bitmap into the bytes at an
 * image's offset is the arithmetic either design needs — but a caller that
 * *stores* its result is storing megabytes the Project is not supposed to hold.
 * The shape ADR 0030 asks for is a Project recording **which image was painted
 * to which bitmap**, and an export applying that to the folder the player
 * supplies again.
 *
 * `AgosEditor`'s `writeZonePixels` hands over whole zone bytes and is
 * therefore the wrong seam to build the rest on. It is left in place because it
 * is what the paint interaction is currently tested through, and replacing it
 * is a change to the Project shape and to export rather than to this file.
 * Written down here so the next person does not wire an app shell to it and
 * discover ADR 0030 afterwards.
 *
 * ## Why the length is checked rather than trusted
 *
 * An image's entry gives an offset and a size, and the encoded bitmap has to
 * be exactly that size. It will be, when the bitmap came from decoding the
 * same image — but a caller can hand over a bitmap of the wrong shape, and the
 * failure that would cause is the worst kind: a longer run would overwrite the
 * *next* image's pixels, so the damage would show up somewhere the author never
 * edited.
 */

import {
  compressedSpriteLength,
  decodeCompressedSprite,
  isCompressedEntry,
  decodeSprite,
  encodeCompressedSprite,
  encodeSprite,
  encodeSpriteRefusal,
  type IndexedBitmap,
} from '../../engine/agos/gfx/agosImage.js';
import { readVgaImageEntry } from '../../engine/agos/gfx/vgaImages.js';

/**
 * The zone's pixel resource with one image replaced.
 *
 * Throws rather than returning a partial result: there is no useful halfway
 * state between a zone that has the edit and one that does not.
 */
export function paintImage(pixels: Uint8Array, image: number, bitmap: IndexedBitmap): Uint8Array {
  const entry = readVgaImageEntry(pixels, image);
  if (!entry) throw new Error(`image ${image} has no entry in this zone`);

  const refusal = encodeSpriteRefusal(entry.flags);
  if (refusal) throw new Error(`image ${image} cannot be written back: ${refusal}`);

  const compressed = isCompressedEntry(entry.flags);
  const encoded = compressed
    ? encodeCompressedSprite(bitmap, entry.widthBytes, entry.height)
    : encodeSprite(bitmap, entry.widthBytes, entry.height);

  /*
   * The encode is checked by decoding it, not by trusting it.
   *
   * The compressed form has many valid encodings of one picture, so "the bytes
   * differ from the original" says nothing about whether the picture survived —
   * and there is no other way to find out. Decoding is cheap next to being
   * wrong: a mis-encoded run does not fail, it draws a plausible other image.
   */
  const check = compressed
    ? decodeCompressedSprite(encoded, entry.widthBytes, entry.height, { opaque: true })
    : decodeSprite(encoded, entry.widthBytes, entry.height, { opaque: true });
  if (!sameBitmap(check, bitmap)) {
    throw new Error(`image ${image} did not survive being re-encoded, so it was not written`);
  }

  if (!compressed) {
    const expected = entry.widthBytes * entry.height;
    if (encoded.length !== expected) {
      // Unreachable while `encodeSprite` derives its length from the same two
      // numbers, and checked anyway: the cost of being wrong here is the *next*
      // image's pixels, which is damage in a place the author never touched.
      throw new Error(`encoded ${encoded.length} bytes for an image of ${expected}`);
    }
    if (entry.offset + expected > pixels.length) {
      throw new Error(
        `image ${image} claims ${expected} bytes at ${entry.offset}, past the end of a ` +
          `${pixels.length}-byte resource`,
      );
    }
    const out = new Uint8Array(pixels);
    out.set(encoded, entry.offset);
    return out;
  }

  /*
   * A compressed image has no fixed length, so it may not fit where it was.
   *
   * The budget is what the original encoding consumed, which is the only thing
   * that can be overwritten without reaching the next image's pixels. Inside it
   * the new bytes go in place and whatever is left of the old ones stays — the
   * decoder stops when it has produced `widthBytes * height` pixels, so the
   * tail is unreachable rather than stale.
   *
   * Past it, the image is **appended and its entry repointed**. That is safe
   * because an entry's offset is the only thing that addresses an image's
   * pixels: nothing walks the block, and the resource's length is derived by
   * the archive writer rather than stored. Growing a zone by a sprite is a few
   * hundred bytes against a resource of hundreds of kilobytes, and the
   * alternative — refusing the paint because it compressed worse than the
   * original — would refuse exactly the edits that add detail.
   */
  const budget = compressedSpriteLength(
    pixels.subarray(entry.offset),
    entry.widthBytes,
    entry.height,
  );

  if (encoded.length <= budget) {
    const out = new Uint8Array(pixels);
    out.set(encoded, entry.offset);
    return out;
  }

  const out = new Uint8Array(pixels.length + encoded.length);
  out.set(pixels, 0);
  out.set(encoded, pixels.length);
  writeEntryOffset(out, image, pixels.length);
  return out;
}

/** Whether a re-encode produced the picture it was given. */
function sameBitmap(left: IndexedBitmap, right: IndexedBitmap): boolean {
  if (left.width !== right.width || left.height !== right.height) return false;
  for (let at = 0; at < left.pixels.length; at += 1) {
    if (left.pixels[at] !== right.pixels[at]) return false;
  }
  return true;
}

/**
 * Points an image's entry at new pixels.
 *
 * Big-endian at `image * 8`, which is where `readVgaImageEntry` reads it from —
 * written here rather than through a shared writer because this is the only
 * field of an entry anything in this project changes, and a general entry
 * writer would be four fields of which three must never move.
 */
function writeEntryOffset(pixels: Uint8Array, image: number, offset: number): void {
  const at = image * 8;
  pixels[at] = (offset >>> 24) & 0xff;
  pixels[at + 1] = (offset >>> 16) & 0xff;
  pixels[at + 2] = (offset >>> 8) & 0xff;
  pixels[at + 3] = offset & 0xff;
}

/**
 * One image an author has painted, as **intent** rather than as bytes.
 *
 * ADR 0030's shape: a Project holds what the author meant and export applies it
 * to the folder the player supplies again. What makes that affordable here is
 * that the unit is a *sprite* and not a zone — a few dozen pixels square at
 * four bits each, where the zone resource it lives in runs to hundreds of
 * kilobytes. So a Project can carry every image an author touched and still be
 * a document rather than a copy of the game.
 *
 * The pixels are one byte per pixel, base64'd, because a Project is serialised
 * as JSON and a `Uint8Array` does not survive that. Not the *packed* four-bit
 * form: packing is what `encodeSprite` does at apply time, and storing the
 * packed form would put the same width-in-bytes arithmetic in two places.
 */
export interface PaintedImage {
  readonly zone: number;
  readonly id: number;
  readonly width: number;
  readonly height: number;
  /** One byte per pixel, base64. */
  readonly pixels: string;
}

/** A bitmap as a {@link PaintedImage}'s payload. */
export function paintedFrom(zone: number, id: number, bitmap: IndexedBitmap): PaintedImage {
  let binary = '';
  for (const value of bitmap.pixels) binary += String.fromCharCode(value);
  return { zone, id, width: bitmap.width, height: bitmap.height, pixels: btoa(binary) };
}

/** The bitmap a {@link PaintedImage} carries. */
export function bitmapOf(painted: PaintedImage): IndexedBitmap {
  const binary = atob(painted.pixels);
  const pixels = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) pixels[at] = binary.charCodeAt(at);
  return { width: painted.width, height: painted.height, pixels };
}

/**
 * Applies every painted image belonging to one zone.
 *
 * The export half of the intent. Takes the zone's bytes as re-supplied and
 * returns them with each painted image written in — so an author's edits are
 * replayed onto the player's own files rather than having been stored as a copy
 * of them.
 *
 * Images for other zones are ignored rather than an error: the list is a
 * Project-wide record and export walks it once per zone.
 */
export function applyPaintedImages(
  pixels: Uint8Array,
  zone: number,
  painted: readonly PaintedImage[],
): Uint8Array {
  let out = pixels;
  for (const each of painted) {
    if (each.zone !== zone) continue;
    out = paintImage(out, each.id, bitmapOf(each));
  }
  return out;
}
