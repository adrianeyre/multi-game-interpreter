/**
 * `nsRect` at SCI32, which is measured differently from SCI16's and without `z`.
 *
 * **A script's own `onMe` is usually a bounding-box test against these four
 * property words**, not a Kernel call — so a wrong `nsRect` is not a cosmetic
 * fault, it is a thing on screen that cannot be clicked.
 *
 * King's Quest VII's chapter-select digits are the case that found it. Each
 * sets `z` to 1000 to order itself; SCI16's arithmetic subtracts `z` as a
 * height above the floor, so all six boxes landed at y −929 to −893 while the
 * digits were drawn at y 81. Every click answered "not on me" — sixty thousand
 * polls a second, all of them false — and the panel could be read and never
 * used. With the rule below the same digit measures (117, 81, 130, 96), the
 * click lands, and the chapter is chosen.
 *
 * `ScreenItem::getNowSeenRect` (`screen_item32.cpp`) is the rule.
 */

import { describe, expect, it } from 'vitest';

import { sci32NowSeenRect } from '../src/engine/sci/gfx/Plane.js';

const SCRIPT = { width: 320, height: 200 };
const HI_RES = { width: 640, height: 480 };

/** King's Quest VII's chapter digit: a 27x36 cel drawn for 640x480. */
const digit = { width: 27, height: 36, displaceX: 0, displaceY: 18 };

describe('a SCI32 nsRect', () => {
  /**
   * The measurement from the game, kept as the number rather than as a shape:
   * this is the rectangle that makes the chapter selector work.
   */
  it("measures King's Quest VII's chapter digit where the digit is", () => {
    expect(sci32NowSeenRect(digit, HI_RES, SCRIPT, 117, 88)).toMatchObject({
      left: 117,
      top: 81,
      right: 130,
      bottom: 96,
    });
  });

  /** The whole point: `z` is not an argument, so it cannot move the box. */
  it('takes no z, so a priority cannot move the rectangle', () => {
    expect(sci32NowSeenRect.length).toBe(5);
  });

  /**
   * A low-resolution cel is the same rule with the ratio at one, which is why
   * there is one formula here and not two.
   */
  it('is the same formula for a cel drawn at the script resolution', () => {
    const cel = { width: 20, height: 30, displaceX: 10, displaceY: 30 };
    expect(sci32NowSeenRect(cel, SCRIPT, SCRIPT, 100, 80)).toMatchObject({
      left: 90,
      top: 50,
      right: 110,
      bottom: 80,
    });
  });

  /** Scaled out of the cel's space, so a hi-res cel covers fewer script pixels. */
  it('scales the cel out of its own resolution and into the script', () => {
    const cel = { width: 64, height: 48, displaceX: 0, displaceY: 0 };
    const hi = sci32NowSeenRect(cel, HI_RES, SCRIPT, 0, 0);
    const low = sci32NowSeenRect(cel, SCRIPT, SCRIPT, 0, 0);
    expect(hi.right).toBe(32);
    expect(hi.bottom).toBe(20);
    expect(low.right).toBe(64);
    expect(low.bottom).toBe(48);
  });

  /** The box contains its own position, which is what makes a click land. */
  it('contains the position it was measured at', () => {
    const rect = sci32NowSeenRect(digit, HI_RES, SCRIPT, 117, 88);
    expect(rect.left).toBeLessThanOrEqual(117);
    expect(rect.right).toBeGreaterThanOrEqual(117);
    expect(rect.top).toBeLessThanOrEqual(88);
    expect(rect.bottom).toBeGreaterThanOrEqual(88);
  });
});
