/**
 * Packing a SCI1.1 cel body, which is the inverse of unpacking one.
 *
 * `writeSciView` rebuilds a pre-V56 View from its cels and **patches a V56 one
 * in place**, so until this existed a V56 cel's pixels — SCI1.1 and every SCI32
 * game, King's Quest VII among them — could be read and never written. That is
 * the second half of `docs/editor-parity.md` row 10: a paint surface without an
 * encoder is an editor that loses the picture.
 *
 * Tested by **round trip**, because that is the property that matters: what
 * comes back out has to be what went in, and the encoder is free to choose any
 * runs it likes to get there.
 */

import { describe, expect, it } from 'vitest';

import { packSci11Cel, unpackSci11CelForTest } from '../src/engine/sci/gfx/SciView.js';

/** Packs, lays the two streams out as a cel body, and unpacks them again. */
function roundTrip(pixels: number[], clearKey: number, inline: boolean): number[] {
  const source = Uint8Array.from(pixels);
  const { control, literal } = packSci11Cel(source, clearKey, inline);

  // The two streams end up in one resource, the literal one after the control
  // one, which is how a real cel record addresses them.
  const resource = new Uint8Array(control.length + literal.length);
  resource.set(control, 0);
  resource.set(literal, control.length);

  const out = new Uint8Array(pixels.length).fill(clearKey);
  unpackSci11CelForTest(resource, 0, inline ? 0 : control.length, out);
  return [...out];
}

describe('packing a SCI1.1 cel body', () => {
  const cases: Array<[string, number[]]> = [
    ['a flat run of one colour', Array.from({ length: 200 }, () => 7)],
    ['nothing but the transparent index', Array.from({ length: 120 }, () => 0)],
    [
      'alternating pixels, which no run can compress',
      Array.from({ length: 99 }, (_, i) => (i % 2 ? 3 : 9)),
    ],
    ['runs longer than the six bits a control byte holds', Array.from({ length: 400 }, () => 5)],
    ['a single pixel between two repeats', [4, 4, 4, 9, 6, 6, 6]],
    ['transparent gaps between colour', [0, 0, 1, 1, 1, 0, 2, 0, 0, 0, 3, 3]],
    ['every index, once each', Array.from({ length: 256 }, (_, i) => i)],
  ];

  for (const [name, pixels] of cases) {
    it(`round-trips ${name}, literals inline`, () => {
      expect(roundTrip(pixels, 0, true)).toEqual(pixels);
    });
    it(`round-trips ${name}, literals in their own stream`, () => {
      expect(roundTrip(pixels, 0, false)).toEqual(pixels);
    });
  }

  /**
   * The transparent index is not always nought, and choosing it wrongly would
   * turn a colour into a skip and lose it.
   */
  it('treats the cel’s own clear key as the skip, not nought', () => {
    const pixels = [0, 0, 5, 5, 200, 200, 200, 0];
    expect(roundTrip(pixels, 200, true)).toEqual(pixels);
    expect(roundTrip(pixels, 0, true)).toEqual(pixels);
  });

  it('answers empty streams for no pixels at all', () => {
    const { control, literal } = packSci11Cel(new Uint8Array(0), 0, true);
    expect(control).toHaveLength(0);
    expect(literal).toHaveLength(0);
  });

  /**
   * A long transparent stretch costs one control byte per 63 pixels and no
   * literals — the property that makes a sprite's surround nearly free.
   */
  it('spends no literal on transparency', () => {
    const { control, literal } = packSci11Cel(new Uint8Array(630).fill(0), 0, true);
    expect(literal).toHaveLength(0);
    expect(control).toHaveLength(10);
  });
});
