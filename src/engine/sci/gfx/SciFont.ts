/**
 * SCI `font` resources: read, and written back (#220, #224).
 *
 * There was no font reader at all before this. Fonts were carried through an
 * import and an export as bytes, which kept the round trip exact and made "this
 * game's fonts are editable" false — and #222's point about localisation is
 * exactly why that matters: accented characters need different glyphs, and a
 * translator who can reach the Messages and not the font has half a tool.
 *
 * ## The format, derived from the games rather than recalled
 *
 * ```
 * u16  0
 * u16  character count
 * u16  line height
 * u16  offset per character
 * ...  per character: u8 width, u8 height, then height rows of ceil(width/8) bytes
 * ```
 *
 * **It is self-checking, which is what makes it safe to claim.** The header, the
 * offset table and the sum of every character's record add up to the resource
 * length exactly — for Conquests of the Longbow's font 0 that is 6 + 256 + 1,486
 * = 1,748 bytes, and for its font 7, 6 + 256 + 3,204 = 3,466. A format read
 * wrongly does not add up, so this is checked over every font in the corpus
 * rather than asserted from one.
 *
 * A glyph is one bit per pixel, most significant bit leftmost, each row padded
 * to a byte — so a nine-pixel-wide character takes two bytes a row and wastes
 * seven bits, which is what Sierra's own renderer expected and what an editor
 * has to write back.
 */

/** One character: a bitmap, one bit per pixel. */
export interface SciGlyph {
  width: number;
  height: number;
  /** One byte per pixel, 1 where the glyph is inked. */
  pixels: Uint8Array;
}

export interface SciFontResource {
  /** The line height the font declares, which is not any glyph's height. */
  lineHeight: number;
  glyphs: SciGlyph[];
  /** Set when the resource did not account for itself, with what was wrong. */
  unrecovered?: string;
}

const HEADER_SIZE = 6;

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

/** Bytes one row of a glyph occupies: one bit per pixel, padded to a byte. */
export function sciGlyphStride(width: number): number {
  return Math.ceil(width / 8);
}

/**
 * Reads a `font` resource.
 *
 * Refuses rather than returning a partial font: a glyph table read at the wrong
 * offset produces characters of plausible sizes made of noise, and text drawn
 * in it looks like a font this project does not have rather than like a fault.
 */
export function readSciFont(resource: Uint8Array): SciFontResource {
  if (resource.length < HEADER_SIZE) {
    return { lineHeight: 0, glyphs: [], unrecovered: 'shorter than a font header' };
  }
  const count = u16(resource, 2);
  const lineHeight = u16(resource, 4);
  const tableEnd = HEADER_SIZE + count * 2;
  if (count === 0 || tableEnd > resource.length) {
    return {
      lineHeight,
      glyphs: [],
      unrecovered: `declares ${count} characters, whose offset table would end at ${tableEnd} of ${resource.length}`,
    };
  }

  const glyphs: SciGlyph[] = [];
  for (let index = 0; index < count; index++) {
    const at = u16(resource, HEADER_SIZE + index * 2);
    if (at + 2 > resource.length) {
      return {
        lineHeight,
        glyphs,
        unrecovered: `character ${index} starts at ${at}, past the end of ${resource.length} bytes`,
      };
    }
    const width = resource[at];
    const height = resource[at + 1];
    const stride = sciGlyphStride(width);
    if (at + 2 + height * stride > resource.length) {
      return {
        lineHeight,
        glyphs,
        unrecovered: `character ${index} is ${width}x${height}, which runs past the end`,
      };
    }

    const pixels = new Uint8Array(width * height);
    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width; column++) {
        const byte = resource[at + 2 + row * stride + (column >> 3)];
        // Most significant bit leftmost, which is the way round Sierra's
        // renderer read it — the other way gives every character mirrored
        // inside its own box, in eight-pixel groups.
        pixels[row * width + column] = (byte >> (7 - (column & 7))) & 1;
      }
    }
    glyphs.push({ width, height, pixels });
  }

  return { lineHeight, glyphs };
}

/**
 * Emits a `font` resource.
 *
 * The offset table is built after the glyph bodies are sized, because every
 * offset depends on every earlier glyph's width — so a character made one pixel
 * wider moves every character after it, and a table written before the bodies
 * is a table written against a layout that never exists. The same reason the
 * Script linker runs in passes.
 */
export function writeSciFont(font: SciFontResource): Uint8Array {
  const bodies = font.glyphs.map((glyph) => {
    const stride = sciGlyphStride(glyph.width);
    const body = new Uint8Array(2 + glyph.height * stride);
    body[0] = glyph.width & 0xff;
    body[1] = glyph.height & 0xff;
    for (let row = 0; row < glyph.height; row++) {
      for (let column = 0; column < glyph.width; column++) {
        if (!glyph.pixels[row * glyph.width + column]) continue;
        body[2 + row * stride + (column >> 3)] |= 1 << (7 - (column & 7));
      }
    }
    return body;
  });

  const tableEnd = HEADER_SIZE + bodies.length * 2;
  const total = bodies.reduce((sum, body) => sum + body.length, tableEnd);
  const out = new Uint8Array(total);
  out[2] = bodies.length & 0xff;
  out[3] = bodies.length >> 8;
  out[4] = font.lineHeight & 0xff;
  out[5] = font.lineHeight >> 8;

  let at = tableEnd;
  for (const [index, body] of bodies.entries()) {
    out[HEADER_SIZE + index * 2] = at & 0xff;
    out[HEADER_SIZE + index * 2 + 1] = at >> 8;
    out.set(body, at);
    at += body.length;
  }
  return out;
}
