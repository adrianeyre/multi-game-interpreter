/**
 * Simon 2's inventory icons, painted from `ICON.DAT`.
 *
 * The last of AGOS's three interfaces to draw anything. Simon 1 paints its verb
 * strip as text through the font (`drawWindow.ts`); Simon 2 makes its bar of
 * *icon buttons* the engine blits itself out of a loose `ICON.DAT` beside the
 * game, and until this file existed the whole bottom band was black — a player
 * had to know where nine invisible boxes were.
 *
 * ## The file, and the two passes
 *
 * `ICON.DAT` is read whole (`loadIconFile` in the reference, `icons.cpp:44`):
 * no decompression, no header, just the bytes. It opens with a table of **two
 * little-endian 16-bit offsets per icon** — `icon * 4 + 0` and `icon * 4 + 2` —
 * each pointing at an RLE stream. An icon is drawn in **two passes** over the
 * same 20x20 cell, one at colour base **224** and one at **208**
 * (`AGOSEngine_Simon2::drawIcon`, `icons.cpp:209`). The two bases are two
 * halves of the icon's palette; a pixel a pass leaves zero is transparent and
 * the other pass (or the panel behind) shows through.
 *
 * ## `decompressIcon` writes down columns, not across rows
 *
 * The RLE (`icons.cpp:150`) is a compact scheme over nibble pairs, and its one
 * surprise is direction: it walks **down a column** by `pitch`, two pixels at a
 * time, and only when a column's `height` iterations are spent does it step one
 * pixel right (`++dst_org`) and start the next column. So a `height` of 10
 * produces a **20-pixel-tall** column (two rows per iteration) and a `width` of
 * 20 produces 20 columns — a 20x20 footprint, which is exactly the hit area
 * `setupIconHitArea` gives a Simon 2 icon.
 *
 * A byte read as a **signed** repeat count chooses the branch: negative is a run
 * of one repeated nibble-pair, non-negative is that many fresh pairs read one
 * after another. Getting the sign wrong turns a run into garbage that still
 * decodes to the right length — a plausible smear — which is why this is
 * transcribed control-flow (ADR 0024) and pinned by its own test.
 */

/** The 20x20 footprint a decompressed Simon 2 icon occupies. */
export const SIMON2_ICON_WIDTH = 20;
export const SIMON2_ICON_HEIGHT = 20;

/**
 * Decompresses one RLE stream into a framebuffer, transcribed from
 * `decompressIcon` (`icons.cpp:150`).
 *
 * Writes down each column by `pitch`, two pixels per step, stepping one pixel
 * right when a column is full. A non-zero nibble is ORed with `base`; a zero
 * nibble is transparent and leaves the destination untouched.
 *
 * `width` is the number of columns and `height` is half the column's pixel
 * height — the reference's own units, kept so a reader can check them against
 * the source.
 */
export function decompressIcon(
  dst: Uint8Array,
  dstOffset: number,
  src: Uint8Array,
  srcOffset: number,
  width: number,
  height: number,
  base: number,
  pitch: number,
): void {
  let s = srcOffset;
  let d = dstOffset;
  let dstOrg = dstOffset;
  let cols = width;
  let h = height;

  const put = (offset: number, colour: number): void => {
    if (offset >= 0 && offset < dst.length) dst[offset] = colour;
  };

  for (;;) {
    // A signed byte: negative selects the repeated-pair branch.
    let reps = ((src[s++] ?? 0) << 24) >> 24;
    if (reps < 0) {
      reps -= 1;
      const byte = src[s++] ?? 0;
      let colour1 = byte >> 4;
      if (colour1 !== 0) colour1 |= base;
      let colour2 = byte & 0xf;
      if (colour2 !== 0) colour2 |= base;

      do {
        if (colour1 !== 0) put(d, colour1);
        d += pitch;
        if (colour2 !== 0) put(d, colour2);
        d += pitch;

        h -= 1;
        if (h === 0) {
          cols -= 1;
          if (cols === 0) return;
          dstOrg += 1;
          d = dstOrg;
          h = height;
        }
      } while (++reps !== 0);
    } else {
      do {
        const byte = src[s++] ?? 0;
        const colour1 = byte >> 4;
        if (colour1 !== 0) put(d, colour1 | base);
        d += pitch;
        const colour2 = byte & 0xf;
        if (colour2 !== 0) put(d, colour2 | base);
        d += pitch;

        h -= 1;
        if (h === 0) {
          cols -= 1;
          if (cols === 0) return;
          dstOrg += 1;
          d = dstOrg;
          h = height;
        }
        // The literal branch reads a fresh nibble-pair every pass; `reps` is
        // how many pairs, so it runs `reps + 1` times.
      } while (--reps >= 0);
    }
  }
}

/**
 * Draws one Simon 2 icon at a cell offset within a window, transcribed from
 * `AGOSEngine_Simon2::drawIcon` (`icons.cpp:209`).
 *
 * `x` and `y` are the icon's offset inside the icon window; `windowY` is the
 * window's own top in pixels. `110` is Simon 2's fixed left margin. The two
 * passes read their stream offsets from the four-byte table entry and draw at
 * bases 224 then 208 into the same cell.
 */
export function drawSimon2Icon(
  dst: Uint8Array,
  iconFile: Uint8Array,
  icon: number,
  x: number,
  y: number,
  windowY: number,
  pitch: number,
): void {
  const base = 110 + x + (y + windowY) * pitch;
  const tableAt = icon * 4;
  if (tableAt + 4 > iconFile.length) return;

  const first = iconFile[tableAt]! | (iconFile[tableAt + 1]! << 8);
  decompressIcon(dst, base, iconFile, first, SIMON2_ICON_WIDTH, 10, 224, pitch);

  const second = iconFile[tableAt + 2]! | (iconFile[tableAt + 3]! << 8);
  decompressIcon(dst, base, iconFile, second, SIMON2_ICON_WIDTH, 10, 208, pitch);
}
