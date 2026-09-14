/**
 * Writing an edited image back into its zone.
 *
 * The last mechanical piece of the paint path. What matters most here is the
 * refusals: the damage a bad write does lands on the *next* image's pixels, so
 * it shows up somewhere the author never edited, which is the hardest kind of
 * corruption to trace back.
 */
import { describe, expect, it } from 'vitest';
import {
  applyPaintedImages,
  bitmapOf,
  paintImage,
  paintedFrom,
} from '../src/authoring/agos/paint.js';
import { decodeCompressedSprite, decodeSprite } from '../src/engine/agos/gfx/agosImage.js';
import { DRAW_FLAGS, readVgaImageEntry } from '../src/engine/agos/gfx/vgaImages.js';

/**
 * A zone with one 4x2 image at offset 32, and a second image's pixels right
 * after it so an overrun would be visible.
 *
 * The entry layout is eight bytes at `image * 8`, and the width is stored in
 * **bits** — not guessable, and got wrong once already.
 */
function zone(flags = 0): Uint8Array {
  const bytes = new Uint8Array(64);
  const view = new DataView(bytes.buffer);
  const at = 1 * 8;
  view.setUint32(at, 32, false);
  bytes[at + 4] = flags;
  bytes[at + 5] = 2; // rows
  view.setUint16(at + 6, 4, false); // four pixels wide, so two bytes a row
  bytes.set([0x12, 0x34, 0x56, 0x78], 32);
  // A sentinel immediately after, standing in for the next image.
  bytes.set([0xee, 0xee], 36);
  return bytes;
}

describe('painting an image back', () => {
  it('replaces just that image and returns a new array', () => {
    const original = zone();
    const bitmap = decodeSprite(original.subarray(32, 36), 2, 2, { opaque: true });
    bitmap.pixels[0] = 0xf;

    const painted = paintImage(original, 1, bitmap);

    expect([...painted.subarray(32, 36)]).toEqual([0xf2, 0x34, 0x56, 0x78]);
    // The original is untouched: the Engine is still reading it, and an edit
    // has to be abandonable.
    expect([...original.subarray(32, 36)]).toEqual([0x12, 0x34, 0x56, 0x78]);
  });

  it('does not run past the image into what follows it', () => {
    // The failure this guards shows up in a *different* image, which is why it
    // has a sentinel rather than a length assertion.
    const original = zone();
    const bitmap = decodeSprite(original.subarray(32, 36), 2, 2, { opaque: true });

    const painted = paintImage(original, 1, bitmap);

    expect([...painted.subarray(36, 38)]).toEqual([0xee, 0xee]);
  });

  it('refuses an image drawn through a mask, whose pixels are half the picture', () => {
    const original = zone(DRAW_FLAGS.masked);
    const bitmap = decodeSprite(new Uint8Array([0, 0, 0, 0]), 2, 2, { opaque: true });

    expect(() => paintImage(original, 1, bitmap)).toThrow(/cannot be written back/);
  });

  it('refuses a bitmap of the wrong shape rather than writing part of it', () => {
    const original = zone();
    // One row where the entry says two.
    const bitmap = decodeSprite(new Uint8Array([0x12, 0x34]), 2, 1, { opaque: true });

    expect(() => paintImage(original, 1, bitmap)).toThrow(/expected 2 rows/);
  });

  it('names an image the zone has no entry for', () => {
    expect(() =>
      paintImage(zone(), 0, decodeSprite(new Uint8Array([0]), 1, 1, { opaque: true })),
    ).toThrow(/no entry/);
  });
});

/**
 * Paint as intent, and replaying it at export.
 *
 * ADR 0030's shape: the Project holds what the author meant, and export applies
 * it to the folder the player supplies again. The unit is a *sprite* rather
 * than a zone, which is what makes carrying it in a document affordable.
 */
describe('paint intent', () => {
  it('round-trips a bitmap through the serialised form', () => {
    // A Project is JSON, and a Uint8Array does not survive that — so the
    // payload is base64 and this is the property that matters.
    const bitmap = decodeSprite(new Uint8Array([0x12, 0x34]), 2, 1, { opaque: true });

    const back = bitmapOf(paintedFrom(2, 1, bitmap));

    expect(back.width).toBe(bitmap.width);
    expect(back.height).toBe(bitmap.height);
    expect([...back.pixels]).toEqual([...bitmap.pixels]);
  });

  it('applies intent onto a re-supplied zone', () => {
    const original = zone();
    const bitmap = decodeSprite(original.subarray(32, 36), 2, 2, { opaque: true });
    bitmap.pixels[0] = 0xf;

    const applied = applyPaintedImages(original, 2, [paintedFrom(2, 1, bitmap)]);

    expect(applied[32]).toBe(0xf2);
    // Untouched: intent is replayed onto the player's bytes, not stored over.
    expect(original[32]).toBe(0x12);
  });

  it('ignores intent belonging to another zone', () => {
    // The list is Project-wide and export walks it once per zone, so a
    // mismatched entry is skipped rather than an error.
    const original = zone();
    const bitmap = decodeSprite(original.subarray(32, 36), 2, 2, { opaque: true });
    bitmap.pixels[0] = 0xf;

    const applied = applyPaintedImages(original, 9, [paintedFrom(2, 1, bitmap)]);

    expect([...applied]).toEqual([...original]);
  });
});

/**
 * Painting a compressed image.
 *
 * The form Simon 1's sprites are almost entirely in, and the one this used to
 * refuse outright — so the Art tab could show that game's art and change none
 * of it. What is asserted here is not the bytes, which have many valid forms,
 * but the picture: an image is written back only if decoding what was written
 * gives the bitmap that went in.
 */
describe('painting a compressed image', () => {
  /**
   * The bit a *pixel entry* uses to say its bytes are run-length coded.
   *
   * Not `DRAW_FLAGS.compressed`, which is a flag a script passes to a draw.
   * Simon 1's entries carry `0x80` and nothing else, and the renderer folds it
   * into the draw flags before decoding — see `isCompressedEntry`.
   */
  const COMPRESSED_ENTRY = 0x80;

  /**
   * A zone whose image 1 is compressed, with a sentinel after it.
   *
   * The stream is column-major and its runs cross column boundaries, so the
   * bytes below are a real encoding rather than four literals: a repeat of two
   * `0x11`s, then two literals, which is exactly the pair of control words the
   * decoder distinguishes.
   */
  function compressedZone(
    flags: number = COMPRESSED_ENTRY,
    // Column 0: a repeat of two 0x11. Column 1: two literals. Both control
    // words the decoder distinguishes, in one image.
    stream: readonly number[] = [0x01, 0x11, 0xfe, 0x56, 0x78],
  ): Uint8Array {
    const bytes = new Uint8Array(64);
    const view = new DataView(bytes.buffer);
    const at = 1 * 8;
    view.setUint32(at, 32, false);
    bytes[at + 4] = flags;
    bytes[at + 5] = 2; // rows
    view.setUint16(at + 6, 4, false); // four pixels wide, so two bytes a row
    bytes.set(stream, 32);
    // A sentinel immediately after, standing in for the next image.
    bytes.set([0xee, 0xee], 32 + stream.length);
    return bytes;
  }

  it('writes one back, and the picture survives the round trip', () => {
    const original = compressedZone();
    const before = decodeCompressedSprite(original.subarray(32), 2, 2, { opaque: true });
    const bitmap = { ...before, pixels: new Uint8Array(before.pixels) };
    bitmap.pixels[0] = 0xf;

    const painted = paintImage(original, 1, bitmap);
    const entry = readVgaImageEntry(painted, 1)!;
    const after = decodeCompressedSprite(painted.subarray(entry.offset), 2, 2, { opaque: true });

    expect([...after.pixels]).toEqual([...bitmap.pixels]);
  });

  it('leaves the original alone, because the engine is still reading it', () => {
    const original = compressedZone();
    const copy = new Uint8Array(original);
    const bitmap = decodeCompressedSprite(original.subarray(32), 2, 2, { opaque: true });
    bitmap.pixels[0] = 0xf;

    paintImage(original, 1, bitmap);

    expect([...original]).toEqual([...copy]);
  });

  it('stays inside the bytes the old encoding used when the new one fits', () => {
    // A picture that compresses to one repeat run is far shorter than the
    // original, so nothing moves and the next image's pixels are untouched.
    const original = compressedZone();
    const bitmap = decodeCompressedSprite(original.subarray(32), 2, 2, { opaque: true });
    bitmap.pixels.fill(3);

    const painted = paintImage(original, 1, bitmap);

    expect(painted.length).toBe(original.length);
    expect(readVgaImageEntry(painted, 1)!.offset).toBe(32);
    expect([...painted.subarray(37, 39)]).toEqual([0xee, 0xee]);
    expect(
      [...decodeCompressedSprite(painted.subarray(32), 2, 2, { opaque: true }).pixels].every(
        (value) => value === 3,
      ),
    ).toBe(true);
  });

  it('appends and repoints the entry when the new encoding is longer', () => {
    // The alternative would be refusing exactly the edits that add detail. An
    // entry's offset is the only thing that addresses an image's pixels, so
    // moving one is a four-byte write.
    // The original is one repeat run — two bytes for the whole image, which is
    // as small as this form gets. Anything with detail in it is longer.
    const original = compressedZone(COMPRESSED_ENTRY, [0x03, 0x00]);
    const bitmap = decodeCompressedSprite(original.subarray(32), 2, 2, { opaque: true });
    bitmap.pixels.set([1, 2, 3, 4, 5, 6, 7, 8]);

    const painted = paintImage(original, 1, bitmap);
    const entry = readVgaImageEntry(painted, 1)!;

    expect(painted.length).toBeGreaterThan(original.length);
    expect(entry.offset).toBe(original.length);
    // The sentinel that stood for the next image never moved.
    expect([...painted.subarray(34, 36)]).toEqual([0xee, 0xee]);
    expect([
      ...decodeCompressedSprite(painted.subarray(entry.offset), 2, 2, { opaque: true }).pixels,
    ]).toEqual([...bitmap.pixels]);
  });

  it('handles the script-side compressed flag the same way', () => {
    // A caller that has the script's flags has more information than one that
    // does not, so those bits are honoured as well as the entry's own.
    const original = compressedZone(DRAW_FLAGS.compressedFlip);
    const bitmap = decodeCompressedSprite(original.subarray(32), 2, 2, { opaque: true });
    bitmap.pixels[3] = 0xd;

    const painted = paintImage(original, 1, bitmap);
    const entry = readVgaImageEntry(painted, 1)!;

    expect([
      ...decodeCompressedSprite(painted.subarray(entry.offset), 2, 2, { opaque: true }).pixels,
    ]).toEqual([...bitmap.pixels]);
  });
});
