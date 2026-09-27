import type { Cel, Costume } from './Costume.js';
import type { RoomGraphics } from './RoomGraphics.js';
import type { Screen } from './Screen.js';
import { BIG_COSTUME_SCALE_TABLE, SMALL_COSTUME_SCALE_TABLE } from './scaleTable.js';
import { shadePixel, type ShadowRule } from './ShadowPalette.js';

/** Half the scale table; the origin the position adjustments count from. */
const SCALE_TABLE_ORIGIN = 128;
/** The same for the big table, which AKOS scales through. */
const BIG_SCALE_TABLE_ORIGIN = 384;

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
  /**
   * How shadow pixels are drawn, or absent for none at all.
   *
   * Absent before v5, whose costume renderer is given no shadow table (the
   * reference only hands one over from v5 on), so colour 13 there is a colour
   * like any other.
   */
  shadow?: ShadowRule;
  /**
   * Scales through the 768-entry table from its 384th entry, unwrapped, rather
   * than the 256-entry one from its 128th with the index wrapping at a byte.
   *
   * Which table is a property of the renderer: a LucasArts AKOS costume's
   * byte-RLE cels use the big one, a classic costume's the small one
   * (`AkosRenderer::paintCelByleRLE`, whose `scaleIndexMask` is -1 there).
   */
  bigScaleTable?: boolean;
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
  const big = options.bigScaleTable ?? false;
  const table = big ? BIG_COSTUME_SCALE_TABLE : SMALL_COSTUME_SCALE_TABLE;
  const origin = big ? BIG_SCALE_TABLE_ORIGIN : SCALE_TABLE_ORIGIN;
  // The small table's index wraps at a byte; the big one's is left alone,
  // and a cel far enough off its anchor to leave it reads nothing it keeps.
  const wrap = big ? (index: number) => index : (index: number) => index & 0xff;

  let x = actorX;
  let y = actorY;
  let startScaleIndexX = origin;
  let startScaleIndexY = origin;

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
      let j = wrap(origin - xMoveCur);
      startScaleIndexX = j;
      for (let i = 0; i < xMoveCur; i++) {
        if (table[wrap(j++)] < scaleX) x -= scaleXStep;
      }
    } else {
      let j = wrap(origin + xMoveCur);
      startScaleIndexX = j;
      for (let i = 0; i < xMoveCur; i++) {
        if (table[wrap(j--)] < scaleX) x += scaleXStep;
      }
    }

    let stepY = -1;
    if (yMoveCur < 0) {
      yMoveCur = -yMoveCur;
      stepY = 1;
    }
    let jy = wrap(origin - yMoveCur);
    startScaleIndexY = jy;
    for (let i = 0; i < yMoveCur; i++) {
      if (table[wrap(jy++)] < scaleY) y -= stepY;
    }
  } else {
    x += drawToRight ? xMoveCur : -xMoveCur;
    y += yMoveCur;
  }

  const drawStep = drawToRight ? 1 : -1;
  let scaleXIndex = startScaleIndexX;
  const { shadow } = options;
  // Where the previous column landed. A scaled cel can draw two source columns
  // to the same screen column, and an AKOS shadow applied twice there would
  // shade the floor twice as dark — so, as in the reference's
  // `byleRLEDecode`, the second shaded write to one column is dropped.
  let previousX = -1;

  for (let column = 0; column < cel.width; column++) {
    let destY = y;
    let scaleYIndex = startScaleIndexY;
    const columnBase = column * cel.height;

    for (let row = 0; row < cel.height; row++) {
      const keepRow = scaleY === 255 || table[wrap(scaleYIndex++)] < scaleY;
      if (!keepRow) continue;

      const color = pixels[columnBase + row];
      if (color !== 0 && destY >= clipTop && destY < clipBottom) {
        const occluded =
          roomGraphics && zPlane > 0
            ? roomGraphics.isMasked(zPlane, x + cameraX, destY - roomTop)
            : false;
        if (!occluded) {
          const mapped = palette[color] ?? color;
          if (!shadow) {
            screen.putPixel(x, destY, mapped);
          } else {
            const shaded = shadePixel(shadow, mapped, screen.getPixel(x, destY));
            if (!(shaded.shaded && shadow.akos && previousX === x)) {
              screen.putPixel(x, destY, shaded.colour);
            }
          }
        }
      }
      destY++;
    }

    previousX = x;
    if (scaleX === 255 || table[wrap(scaleXIndex)] < scaleX) x += drawStep;
    scaleXIndex = wrap(scaleXIndex + drawStep);
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
