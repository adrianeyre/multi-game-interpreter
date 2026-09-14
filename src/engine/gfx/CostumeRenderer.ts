import type { Cel, Costume } from './Costume.js';
import type { RoomGraphics } from './RoomGraphics.js';
import type { Screen } from './Screen.js';
import { SMALL_COSTUME_SCALE_TABLE } from './scaleTable.js';

/** Half the scale table; the origin the position adjustments count from. */
const SCALE_TABLE_ORIGIN = 128;

export interface CelDrawOptions {
  /** Actor position in screen coordinates (feet). */
  actorX: number;
  actorY: number;
  /** Accumulated cel offsets for this limb. */
  xMove: number;
  yMove: number;
  /** 1..255, where 255 is full size. */
  scaleX: number;
  scaleY: number;
  /** False draws the cel mirrored, for actors facing west. */
  drawToRight: boolean;
  /** Costume colour index -> screen palette index. */
  palette: Uint8Array;
  /** Room graphics and offsets, for z-plane clipping. */
  roomGraphics?: RoomGraphics;
  /** Room x of screen x = 0. */
  cameraX?: number;
  /** Screen y of room y = 0. */
  roomTop?: number;
  /** Which z-plane occludes this actor; 0 means "always in front". */
  zPlane?: number;
  /** Clipping band in screen coordinates. */
  clipTop: number;
  clipBottom: number;
}

/**
 * Draws one decoded cel.
 *
 * Scaling drops source rows and columns using an ordered-dither table rather
 * than resampling, which is what the original did and what makes scaled
 * sprites look the way players remember rather than blurry.
 */
export function drawCel(
  screen: Screen,
  _costume: Costume,
  cel: Cel,
  pixels: Uint8Array,
  options: CelDrawOptions,
): void {
  const {
    actorX,
    actorY,
    scaleX,
    scaleY,
    drawToRight,
    palette,
    roomGraphics,
    cameraX = 0,
    roomTop = 0,
    zPlane = 0,
    clipTop,
    clipBottom,
  } = options;

  const scaled = scaleX !== 255 || scaleY !== 255;
  const table = SMALL_COSTUME_SCALE_TABLE;

  let x = actorX;
  let y = actorY;
  let startScaleIndexX = SCALE_TABLE_ORIGIN;
  let startScaleIndexY = SCALE_TABLE_ORIGIN;

  let xMoveCur = options.xMove;
  let yMoveCur = options.yMove;

  if (scaled) {
    // Walk the table over the cel's offset so the sprite's anchor shrinks
    // toward the actor's feet at the same rate as the artwork.
    let scaleXStep = -1;
    if (xMoveCur < 0) {
      xMoveCur = -xMoveCur;
      scaleXStep = 1;
    }

    if (drawToRight) {
      let j = (SCALE_TABLE_ORIGIN - xMoveCur) & 0xff;
      startScaleIndexX = j;
      for (let i = 0; i < xMoveCur; i++) {
        if (table[j++ & 0xff] < scaleX) x -= scaleXStep;
      }
    } else {
      let j = (SCALE_TABLE_ORIGIN + xMoveCur) & 0xff;
      startScaleIndexX = j;
      for (let i = 0; i < xMoveCur; i++) {
        if (table[j-- & 0xff] < scaleX) x += scaleXStep;
      }
    }

    let stepY = -1;
    if (yMoveCur < 0) {
      yMoveCur = -yMoveCur;
      stepY = 1;
    }
    let jy = (SCALE_TABLE_ORIGIN - yMoveCur) & 0xff;
    startScaleIndexY = jy;
    for (let i = 0; i < yMoveCur; i++) {
      if (table[jy++ & 0xff] < scaleY) y -= stepY;
    }
  } else {
    x += drawToRight ? xMoveCur : -xMoveCur;
    y += yMoveCur;
  }

  const drawStep = drawToRight ? 1 : -1;
  let scaleXIndex = startScaleIndexX;

  for (let column = 0; column < cel.width; column++) {
    let destY = y;
    let scaleYIndex = startScaleIndexY;
    const columnBase = column * cel.height;

    for (let row = 0; row < cel.height; row++) {
      const keepRow = scaleY === 255 || table[scaleYIndex++ & 0xff] < scaleY;
      if (!keepRow) continue;

      const color = pixels[columnBase + row];
      if (color !== 0 && destY >= clipTop && destY < clipBottom) {
        const occluded =
          roomGraphics && zPlane > 0
            ? roomGraphics.isMasked(zPlane, x + cameraX, destY - roomTop)
            : false;
        if (!occluded) screen.putPixel(x, destY, palette[color] ?? color);
      }
      destY++;
    }

    if (scaleX === 255 || table[scaleXIndex & 0xff] < scaleX) x += drawStep;
    scaleXIndex = (scaleXIndex + drawStep) & 0xff;
  }
}

/**
 * Builds the costume-index -> screen-colour table for an actor.
 *
 * An actor's palette overrides individual costume colours (0xFF means "leave
 * it alone"), which is how the same costume is reused for several characters
 * in different clothes.
 */
export function buildCostumePalette(costume: Costume, actorPalette: Uint8Array): Uint8Array {
  const out = new Uint8Array(costume.numColors);
  for (let i = 0; i < costume.numColors; i++) {
    const override = actorPalette[i];
    out[i] = override === 255 ? costume.palette[i] : override;
  }
  return out;
}
