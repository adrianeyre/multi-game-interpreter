import { describe, expect, it } from 'vitest';
import {
  readSkyGraphic,
  readSkyFrame,
  isSkyPalette,
  isSkyScreen,
  parseSkyPalette,
  skyPixelsToRgb,
  SkyGraphicError,
  SKY_PALETTE_BYTES,
  SKY_SCREEN_BYTES,
  SKY_GAME_AREA_BYTES,
  SKY_GRID_X,
  SKY_GRID_Y,
  SKY_GRID_W,
  SKY_GRID_H,
  isSkyGameArea,
  decodeSkyGameArea,
  SKY_SPRITE_HEADER_BYTES,
  parseSkySpriteHeader,
  blitSkySprite,
} from '../src/engine/sky/gfx/skyGraphic.js';

/** A picture, built from the geometry the measurement established. */
function buildGraphic(
  width: number,
  height: number,
  frames: number,
  overrides: Partial<Record<'frameBytes' | 'padding', number>> = {},
): Uint8Array {
  const frameBytes = overrides.frameBytes ?? width * height;
  const bytes = new Uint8Array(22 + frameBytes * frames + (overrides.padding ?? 0));
  const word = (index: number, value: number): void => {
    bytes[index * 2] = value & 0xff;
    bytes[index * 2 + 1] = (value >> 8) & 0xff;
  };
  word(3, width);
  word(4, height);
  word(5, frameBytes);
  word(7, frames);
  for (let i = 22; i < bytes.length; i += 1) bytes[i] = (i - 22) & 0xff;
  return bytes;
}

describe('readSkyGraphic', () => {
  it('reads the geometry when it describes the resource exactly', () => {
    const graphic = readSkyGraphic(buildGraphic(24, 24, 13))!;
    expect(graphic).toEqual({ width: 24, height: 24, frameBytes: 576, frames: 13 });
  });

  it('answers null when the geometry does not describe the resource', () => {
    // The whole of the test, and the whole of the evidence: across both shipped
    // releases, 961 resources describe themselves exactly and *none* has a
    // length that fits while its width times height does not.
    expect(readSkyGraphic(buildGraphic(24, 24, 2, { frameBytes: 500 }))).toBeNull();
    expect(readSkyGraphic(buildGraphic(24, 24, 2, { padding: 1 }))).toBeNull();
    expect(readSkyGraphic(buildGraphic(0, 24, 2))).toBeNull();
    expect(readSkyGraphic(new Uint8Array(8))).toBeNull();
  });

  it('cuts a frame out, and refuses one that is not there', () => {
    const bytes = buildGraphic(4, 2, 3);
    const graphic = readSkyGraphic(bytes)!;
    expect(readSkyFrame(bytes, graphic, 1)).toEqual(bytes.subarray(22 + 8, 22 + 16));
    expect(() => readSkyFrame(bytes, graphic, 3)).toThrow(SkyGraphicError);
  });
});

describe('Sky palettes and screens', () => {
  it('recognises a full screen by its length alone', () => {
    expect(isSkyScreen(new Uint8Array(SKY_SCREEN_BYTES))).toBe(true);
    expect(isSkyScreen(new Uint8Array(SKY_SCREEN_BYTES - 1))).toBe(false);
  });

  it('needs both halves to call something a palette', () => {
    const palette = new Uint8Array(SKY_PALETTE_BYTES).fill(0x3f);
    expect(isSkyPalette(palette)).toBe(true);

    // A component above the 6-bit VGA range, which arbitrary data has and a
    // palette does not.
    palette[100] = 0x40;
    expect(isSkyPalette(palette)).toBe(false);
    expect(isSkyPalette(new Uint8Array(SKY_PALETTE_BYTES - 3).fill(0x3f))).toBe(false);
  });

  it('widens six bits to eight so white stays white and black stays black', () => {
    const bytes = new Uint8Array(SKY_PALETTE_BYTES);
    bytes[3] = 0x3f;
    bytes[4] = 0x20;
    bytes[5] = 0x00;
    const palette = parseSkyPalette(bytes);
    expect(palette[0]).toEqual({ r: 0, g: 0, b: 0 });
    // Multiplying by four alone would cap this at 252 and tint every bright
    // area very slightly dark.
    expect(palette[1].r).toBe(255);
    expect(palette[1].b).toBe(0);
  });

  it('refuses to read something that is not a palette', () => {
    expect(() => parseSkyPalette(new Uint8Array(10))).toThrow(/is not a palette/);
  });

  it('turns palette indices into RGB', () => {
    const bytes = new Uint8Array(SKY_PALETTE_BYTES);
    bytes[3] = 0x3f;
    const rgb = skyPixelsToRgb(Uint8Array.from([0, 1]), parseSkyPalette(bytes));
    expect([...rgb]).toEqual([0, 0, 0, 255, 0, 0]);
  });
});

/**
 * A room background is tiles, and reading it as rows is the failure that looks
 * like a palette bug: right size, right colours, horizontal banding.
 */
describe('a room background', () => {
  it('is the game area rather than the whole display', () => {
    // 320x192, not 320x200 — the bottom eight rows are the panel. The engine
    // asked for 64,000 bytes and every room background in the game is 61,440,
    // so nothing ever matched and nothing was ever drawn.
    expect(SKY_GAME_AREA_BYTES).toBe(320 * 192);
    expect(SKY_SCREEN_BYTES).toBe(320 * 200);
    expect(isSkyGameArea(new Uint8Array(SKY_GAME_AREA_BYTES))).toBe(true);
    expect(isSkyGameArea(new Uint8Array(SKY_SCREEN_BYTES))).toBe(false);
  });

  it('unpacks 20x24 cells of 16x8 into rows', () => {
    // Each cell is filled with its own index, so a correctly placed cell is
    // readable at the pixel that belongs to it and a row-by-row reading is not.
    const cells = SKY_GRID_X * SKY_GRID_Y;
    const tiled = new Uint8Array(SKY_GAME_AREA_BYTES);
    for (let cell = 0; cell < cells; cell += 1) {
      tiled.fill(cell & 0xff, cell * SKY_GRID_W * SKY_GRID_H, (cell + 1) * SKY_GRID_W * SKY_GRID_H);
    }

    const rows = decodeSkyGameArea(tiled);

    for (let cellY = 0; cellY < SKY_GRID_Y; cellY += 1) {
      for (let cellX = 0; cellX < SKY_GRID_X; cellX += 1) {
        const expected = (cellY * SKY_GRID_X + cellX) & 0xff;
        const topLeft = cellY * SKY_GRID_H * 320 + cellX * SKY_GRID_W;
        expect(rows[topLeft]).toBe(expected);
        // And the cell's far corner, which a row-by-row reading puts elsewhere.
        expect(rows[topLeft + (SKY_GRID_H - 1) * 320 + (SKY_GRID_W - 1)]).toBe(expected);
      }
    }
  });

  it('refuses a resource that is not a game area rather than banding it', () => {
    expect(() => decodeSkyGameArea(new Uint8Array(SKY_SCREEN_BYTES))).toThrow(/61440 bytes/);
  });
});

/**
 * Sprites, which are what a room with a correct background was missing.
 */
describe('a sprite', () => {
  /** A sprite resource: 22-byte header, then `frames` frames of pixels. */
  function buildSprite(
    width: number,
    height: number,
    frames: number,
    offsetX = 0,
    offsetY = 0,
  ): Uint8Array {
    const frameBytes = width * height;
    const out = new Uint8Array(SKY_SPRITE_HEADER_BYTES + frameBytes * frames);
    const view = new DataView(out.buffer);
    view.setUint16(6, width, true);
    view.setUint16(8, height, true);
    view.setUint16(10, frameBytes, true);
    view.setUint16(14, frames, true);
    view.setInt16(16, offsetX, true);
    view.setInt16(18, offsetY, true);
    // Frame n is filled with n+1, so a wrong frame index is visible.
    for (let frame = 0; frame < frames; frame += 1) {
      out.fill(
        frame + 1,
        SKY_SPRITE_HEADER_BYTES + frame * frameBytes,
        SKY_SPRITE_HEADER_BYTES + (frame + 1) * frameBytes,
      );
    }
    return out;
  }

  it('reads its header and refuses what cannot be one', () => {
    const header = parseSkySpriteHeader(buildSprite(4, 3, 2, -1, -2))!;
    expect(header).toMatchObject({ width: 4, height: 3, frames: 2, offsetX: -1, offsetY: -2 });
    expect(parseSkySpriteHeader(new Uint8Array(8))).toBeNull();
    // 22 bytes of header and no room for the frame it claims.
    expect(parseSkySpriteHeader(new Uint8Array(SKY_SPRITE_HEADER_BYTES))).toBeNull();
  });

  it('draws the frame asked for, with colour 0 left transparent', () => {
    const bytes = buildSprite(2, 2, 2);
    const header = parseSkySpriteHeader(bytes)!;
    // Punch a hole in frame 1 so transparency is observable.
    bytes[SKY_SPRITE_HEADER_BYTES + 4] = 0;

    const target = new Uint8Array(320 * 200).fill(9);
    // Origin cancels the coordinates, so the sprite lands at 0,0.
    expect(blitSkySprite(target, bytes, header, 1, 10, 20, 10, 20)).toBe(true);

    // Frame 1 is filled with 2, and its first pixel was zeroed.
    expect(target[0]).toBe(9);
    expect(target[1]).toBe(2);
    expect(target[320]).toBe(2);
  });

  /**
   * Clipping clips the *source* and keeps the full sprite's row stride. Using
   * the clipped width as the stride shears the image diagonally, which is the
   * recognisable symptom of getting this wrong.
   */
  it('clips against the left edge without shearing', () => {
    const bytes = buildSprite(4, 2, 1);
    const header = parseSkySpriteHeader(bytes)!;
    // Mark the last column of each row so a stride error is detectable.
    bytes[SKY_SPRITE_HEADER_BYTES + 3] = 7;
    bytes[SKY_SPRITE_HEADER_BYTES + 7] = 8;

    const target = new Uint8Array(320 * 200);
    // x = -2: two columns clipped away, two drawn at the left edge.
    expect(blitSkySprite(target, bytes, header, 0, -2, 0, 0, 0)).toBe(true);
    expect(target[0]).toBe(1);
    expect(target[1]).toBe(7);
    expect(target[320]).toBe(1);
    expect(target[321]).toBe(8);
  });

  it('reports nothing drawn when clipping leaves nothing', () => {
    const bytes = buildSprite(4, 4, 1);
    const header = parseSkySpriteHeader(bytes)!;
    const target = new Uint8Array(320 * 200);
    expect(blitSkySprite(target, bytes, header, 0, -400, 0, 0, 0)).toBe(false);
    expect(blitSkySprite(target, bytes, header, 0, 0, -400, 0, 0)).toBe(false);
    expect(target.every((pixel) => pixel === 0)).toBe(true);
  });
});
