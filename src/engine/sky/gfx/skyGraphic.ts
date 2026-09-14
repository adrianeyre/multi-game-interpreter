/**
 * Beneath a Steel Sky's pictures: the 22-byte prefix's geometry, and palettes.
 *
 * `SkyResources` carries that prefix and deliberately declined to name most of
 * it, on the grounds that "a renderer is what can check such a name, by drawing
 * with it". Two of the eleven words were named there because the RNC header
 * could check them. Four more are named here, and the check turned out to be
 * arithmetic rather than eyesight — which is stronger, because it covers every
 * resource rather than the ones somebody looked at.
 *
 * ## The measurement
 *
 * For a resource whose prefix is part of it, ask whether
 * `width × height × frames + 22` is the resource's own length. Across both
 * shipped releases:
 *
 * | | Floppy | CD |
 * | --- | --- | --- |
 * | Resources where the geometry describes the file exactly | **961** | **961** |
 * | Resources whose length fits and whose `width × height` does not | **0** | **0** |
 *
 * Zero counter-examples is the part that matters. A wrong reading of any of
 * those four words would produce resources of the second kind, and there are
 * none — on either release, at either scale. The largest picture is 241×183
 * with 88 frames, which is inside a 320×200 screen, as it has to be.
 *
 * The rest of the prefix stays unnamed. `s_x` and `s_y` and the two offsets
 * would be checked by drawing a sprite *in a room* rather than on its own, and
 * that is the renderer's next step rather than this one's.
 *
 * ## Full screens are the other shape, and are not this
 *
 * A room background carries no prefix at all — its index entry says the
 * unpacked result excludes it — and is exactly 64,000 bytes, which is 320×200
 * at one byte a pixel. There are 33 of them in the CD release. They need no
 * geometry because they are the screen.
 */

/** The prefix `SkyResources` carries, whose geometry this file reads. */
const HEADER_BYTES = 22;

/** 320×200 at one byte a pixel, which is what a full screen is. */
export const SKY_SCREEN_WIDTH = 320;
export const SKY_SCREEN_HEIGHT = 200;
export const SKY_SCREEN_BYTES = SKY_SCREEN_WIDTH * SKY_SCREEN_HEIGHT;

/**
 * The rows a room's background covers, which is not the whole display.
 *
 * The game's screen is 320x200 and its *game area* is the top 320x192; the
 * bottom eight rows are the panel the game draws over. ScummVM keeps both —
 * `GAME_SCREEN_HEIGHT` 192 and `FULL_SCREEN_HEIGHT` 200 — and this project had
 * only the second, which meant `isSkyScreen` asked for 64,000 bytes and every
 * room background in the game is 61,440. Nothing matched, so nothing was ever
 * drawn as a background; the 320x200 resources that did match are full-screen
 * stills rather than rooms.
 */
export const SKY_GAME_AREA_HEIGHT = 192;
export const SKY_GAME_AREA_BYTES = SKY_SCREEN_WIDTH * SKY_GAME_AREA_HEIGHT;

/**
 * The game area is stored as tiles, not as rows.
 *
 * `Screen::recreate` walks a 20x24 grid and copies each cell as eight rows of
 * sixteen bytes, advancing through the resource linearly — so a background is
 * 480 tiles of 16x8 in row-major tile order, and the numbers multiply out to
 * the 61,440 bytes every room background is. It exists in that shape because
 * the game redraws only the cells its grid marks dirty.
 *
 * Reading it as 192 rows of 320 produces a picture that is the right size, the
 * right palette and unmistakably wrong — horizontal banding, because each row
 * of the output is built from twenty unrelated tiles. That is worth stating
 * because it is the failure that looks like a decoding bug in the palette.
 */
export const SKY_GRID_X = 20;
export const SKY_GRID_Y = 24;
export const SKY_GRID_W = 16;
export const SKY_GRID_H = 8;

/** A palette is 256 entries of three 6-bit components. */
export const SKY_PALETTE_COLOURS = 256;
export const SKY_PALETTE_BYTES = SKY_PALETTE_COLOURS * 3;

/** VGA DACs take six bits per channel, so a component never exceeds this. */
const VGA_MAX_COMPONENT = 0x3f;

export class SkyGraphicError extends Error {}

/** A picture: its geometry, and where its frames start. */
export interface SkyGraphic {
  readonly width: number;
  readonly height: number;
  /** Bytes per frame, which is `width × height` and is checked to be. */
  readonly frameBytes: number;
  readonly frames: number;
}

/**
 * Reads the geometry, or returns null when these bytes are not a picture.
 *
 * Null rather than a throw, because most of `sky.dsk` is not pictures — it is
 * text, sound, scripts and tables — and a caller sweeping the file is asking a
 * question rather than making a mistake.
 *
 * The test is the measurement above: the geometry has to describe the resource
 * exactly. That is a strong filter, and it is the *only* filter, because
 * nothing in the index says what a resource holds.
 */
export function readSkyGraphic(bytes: Uint8Array): SkyGraphic | null {
  if (bytes.length <= HEADER_BYTES) return null;
  const word = (index: number): number => bytes[index * 2] | (bytes[index * 2 + 1] << 8);

  const width = word(3);
  const height = word(4);
  const frameBytes = word(5);
  const frames = word(7);
  if (width === 0 || height === 0 || frames === 0) return null;
  if (width * height !== frameBytes) return null;
  if (frameBytes * frames + HEADER_BYTES !== bytes.length) return null;

  return { width, height, frameBytes, frames };
}

/**
 * One frame's pixels, as palette indices.
 *
 * A view rather than a copy: a picture with 88 frames is 88 allocations the
 * caller usually does not want, and the bytes are not modified by drawing them.
 */
export function readSkyFrame(bytes: Uint8Array, graphic: SkyGraphic, frame: number): Uint8Array {
  if (frame < 0 || frame >= graphic.frames) {
    throw new SkyGraphicError(
      `This picture has ${graphic.frames} frames and frame ${frame} was asked for.`,
    );
  }
  const at = HEADER_BYTES + frame * graphic.frameBytes;
  return bytes.subarray(at, at + graphic.frameBytes);
}

/** True when a resource is a full screen: 320×200, one byte a pixel. */
export function isSkyScreen(bytes: Uint8Array): boolean {
  return bytes.length === SKY_SCREEN_BYTES;
}

/**
 * True when a resource is a room's background — the game area, not the display.
 *
 * A separate predicate from `isSkyScreen` rather than a widened one, because
 * the two lengths mean different things: a 320x200 resource covers the panel
 * and a 320x192 one is a room with the panel left alone.
 */
export function isSkyGameArea(bytes: Uint8Array): boolean {
  return bytes.length === SKY_GAME_AREA_BYTES;
}

/**
 * Turns a tiled game area into 192 rows of 320 pixels.
 *
 * The inverse of the grid walk in `Screen::recreate`: cells in row-major order,
 * each eight rows of sixteen bytes, written to where the cell belongs.
 */
export function decodeSkyGameArea(bytes: Uint8Array): Uint8Array {
  if (!isSkyGameArea(bytes)) {
    throw new SkyGraphicError(
      `A room background is ${SKY_GAME_AREA_BYTES} bytes — ${SKY_GRID_X}x${SKY_GRID_Y} cells of ` +
        `${SKY_GRID_W}x${SKY_GRID_H} — and this resource is ${bytes.length}.`,
    );
  }

  const out = new Uint8Array(SKY_GAME_AREA_BYTES);
  let at = 0;
  for (let cellY = 0; cellY < SKY_GRID_Y; cellY += 1) {
    for (let cellX = 0; cellX < SKY_GRID_X; cellX += 1) {
      const left = cellX * SKY_GRID_W;
      const top = cellY * SKY_GRID_H;
      for (let row = 0; row < SKY_GRID_H; row += 1) {
        out.set(bytes.subarray(at, at + SKY_GRID_W), (top + row) * SKY_SCREEN_WIDTH + left);
        at += SKY_GRID_W;
      }
    }
  }
  return out;
}

/**
 * True when a resource is a palette.
 *
 * Both halves matter and the second is what makes it a test rather than a
 * guess: 768 bytes is a common enough length, and **every byte** of a palette
 * falls inside the 6-bit VGA range, which arbitrary data does not. The CD
 * release holds 29 resources that pass both. The same test `lureDisk.ts` makes,
 * at this family's own palette size.
 */
export function isSkyPalette(bytes: Uint8Array): boolean {
  if (bytes.length !== SKY_PALETTE_BYTES) return false;
  return bytes.every((component) => component <= VGA_MAX_COMPONENT);
}

export interface SkyColour {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * Reads a palette into 8-bit RGB.
 *
 * Scaled `(c << 2) | (c >> 4)` rather than `c * 255 / 63`, which spreads six
 * bits across eight so full-scale stays full-scale and black stays black.
 * Multiplying by four alone caps white at 252 and tints every bright area very
 * slightly dark — the same reasoning, and the same line, as Lure's.
 */
export function parseSkyPalette(bytes: Uint8Array): SkyColour[] {
  if (!isSkyPalette(bytes)) {
    throw new SkyGraphicError(
      `This resource is ${bytes.length} bytes and a Sky palette is ${SKY_PALETTE_BYTES}, or it ` +
        `holds a component above the 6-bit VGA range. It is not a palette.`,
    );
  }
  const colours: SkyColour[] = [];
  const widen = (c: number): number => ((c << 2) | (c >> 4)) & 0xff;
  for (let i = 0; i < SKY_PALETTE_COLOURS; i += 1) {
    const at = i * 3;
    colours.push({ r: widen(bytes[at]), g: widen(bytes[at + 1]), b: widen(bytes[at + 2]) });
  }
  return colours;
}

/** Palette indices to RGB triples, for a framebuffer or a PNG. */
export function skyPixelsToRgb(pixels: Uint8Array, palette: readonly SkyColour[]): Uint8Array {
  const rgb = new Uint8Array(pixels.length * 3);
  for (let i = 0; i < pixels.length; i += 1) {
    const colour = palette[pixels[i]] ?? { r: 0, g: 0, b: 0 };
    rgb[i * 3] = colour.r;
    rgb[i * 3 + 1] = colour.g;
    rgb[i * 3 + 2] = colour.b;
  }
  return rgb;
}

/**
 * A sprite resource's header — 22 bytes, then the frames.
 *
 * Transcribed from ScummVM's `DataFileHeader`, whose own comments name the
 * `flag` bits: bit 0 set for colour data, bit 1 for compressed, bit 2 for 32
 * colours rather than 16. None of the three is acted on here, because every
 * sprite the shipped game draws on its opening screen is plain 8-bit paletted
 * data and a flag nothing reads is better absent than half-honoured.
 */
export const SKY_SPRITE_HEADER_BYTES = 22;

export interface SkySpriteHeader {
  readonly flag: number;
  readonly width: number;
  readonly height: number;
  /** Bytes per frame, which is how a frame index becomes an offset. */
  readonly frameBytes: number;
  readonly frames: number;
  /** Added to the Compact's coordinates before drawing. Signed. */
  readonly offsetX: number;
  readonly offsetY: number;
}

/**
 * Reads a sprite's header, or null when the resource cannot be one.
 *
 * Null rather than throwing: the draw list names a resource per Compact and a
 * Compact can point at something this reader does not understand, which is a
 * sprite not drawn rather than a tick that fails. The caller counts it.
 */
export function parseSkySpriteHeader(bytes: Uint8Array): SkySpriteHeader | null {
  if (bytes.length < SKY_SPRITE_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header: SkySpriteHeader = {
    flag: view.getUint16(0, true),
    width: view.getUint16(6, true),
    height: view.getUint16(8, true),
    frameBytes: view.getUint16(10, true),
    frames: view.getUint16(14, true),
    offsetX: view.getInt16(16, true),
    offsetY: view.getInt16(18, true),
  };

  // A sprite with no area, or one whose first frame does not fit the resource,
  // is something else that happens to be 22 bytes or longer.
  if (header.width === 0 || header.height === 0) return null;
  if (SKY_SPRITE_HEADER_BYTES + header.width * header.height > bytes.length) return null;
  return header;
}

/**
 * Blits one frame of a sprite over a 320x200 framebuffer.
 *
 * **Colour 0 is transparent**, which is the whole reason a room looks empty
 * without this rather than wrong: the background is already correct and the
 * sprites are the part that was never composited.
 *
 * Clipping follows the game's own, which clips the *source* rather than
 * skipping the sprite: a sprite off the left edge advances into its own rows by
 * the overlap and keeps the row stride of the full sprite, so the pixels that
 * remain land in the right places. Getting that wrong shears the image
 * diagonally, which is the recognisable symptom of using the clipped width as
 * the stride.
 *
 * Returns false when there is nothing left after clipping.
 */
export function blitSkySprite(
  target: Uint8Array,
  bytes: Uint8Array,
  header: SkySpriteHeader,
  frame: number,
  compactX: number,
  compactY: number,
  originX: number,
  originY: number,
): boolean {
  let width = header.width;
  let height = header.height;
  let source = SKY_SPRITE_HEADER_BYTES + (frame % Math.max(1, header.frames)) * header.frameBytes;

  let y = compactY + header.offsetY - originY;
  if (y < 0) {
    const above = -y;
    if (height <= above) return false;
    height -= above;
    source += header.width * above;
    y = 0;
  } else {
    const below = SKY_GAME_AREA_HEIGHT - header.height - y;
    if (below < 0) {
      if (height <= -below) return false;
      height -= -below;
    }
  }

  let x = compactX + header.offsetX - originX;
  let skipLeft = 0;
  let skipRight = 0;
  if (x < 0) {
    skipLeft = -x;
    if (width <= skipLeft) return false;
    width -= skipLeft;
    x = 0;
  } else {
    const right = SKY_SCREEN_WIDTH - (header.width + x);
    if (right < 0) {
      skipRight = -right + 1;
      if (width <= skipRight) return false;
      width -= skipRight;
    }
  }

  if (y >= SKY_GAME_AREA_HEIGHT || x >= SKY_SCREEN_WIDTH) return false;
  if (x + width > SKY_SCREEN_WIDTH || y + height > SKY_GAME_AREA_HEIGHT) return false;

  for (let row = 0; row < height; row += 1) {
    const from = source + row * (width + skipLeft + skipRight) + skipLeft;
    const to = (y + row) * SKY_SCREEN_WIDTH + x;
    if (from + width > bytes.length) return row > 0;
    for (let column = 0; column < width; column += 1) {
      const pixel = bytes[from + column];
      if (pixel !== 0) target[to + column] = pixel;
    }
  }
  return true;
}
