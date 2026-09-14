/**
 * SCI32's `Array` Kernel call, against what Sierra's own `Array` class asks of
 * it — and the selector names a game's `vocab.997` really holds.
 *
 * Both halves of this file are here because of one bug with two causes, and
 * neither cause was visible from inside this repository: King's Quest VII's
 * heroine walked to (0, 0) whatever was clicked, and then, once that was
 * mended, walked past wherever she was sent and off the edge of the room.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { SciHeap } from '../src/engine/sci/script/segments.js';
import { SCI_KERNEL } from '../src/engine/sci/script/SciKernel.js';
import type { SciKernelWorld } from '../src/engine/sci/script/SciKernel.js';

type Ref = { segment: number; offset: number };
const reg = (value: number | Ref): Ref =>
  typeof value === 'number' ? { segment: 0, offset: value } : value;

/** The heap hands back its own `Reg`; this file only needs its shape. */
const asRef = (value: unknown): Ref => value as Ref;

/** Enough of a world for the array sub-functions, which touch the heap only. */
function arrayWorld(): { world: SciKernelWorld; heap: SciHeap } {
  const heap = new SciHeap();
  const world = {
    heap,
    machine: { object: () => null },
    log: () => {},
  } as unknown as SciKernelWorld;
  return { world, heap };
}

const call = (world: SciKernelWorld, ...args: Array<number | Ref>) =>
  SCI_KERNEL.Array(world, args.map(reg) as never);

describe("SCI32 Array, against Sierra's own Array class", () => {
  /**
   * `Array::new` in script 64920 compiles to `callKernel(0, size, self.type)`
   * — the size the caller asked for, then the element type the class holds in
   * a property. Read the other way round, `IntArray new: 10` asks for ten
   * elements of type 0 and is given zero elements of type 10.
   *
   * That is not a cosmetic swap. A zero-length array accepts every write and
   * keeps none of them, so a script that fills one and reads it back gets
   * zeroes and no error anywhere. It is why the ego walked to (0, 0): the walk
   * destination is copied into a fresh `IntArray`, and the fresh array had no
   * room in it.
   */
  it('takes the size first and the type second', () => {
    const { world, heap } = arrayWorld();
    const array = call(world, 0, 6, 0);
    expect(heap.arrayLength(array)).toBe(6);
    expect(heap.arrayType(array)).toBe(0);

    // A byte array, where getting it backwards also halves the element width.
    const bytes = call(world, 0, 5, 3);
    expect(heap.arrayLength(bytes)).toBe(5);
    expect(heap.elementWidth(bytes)).toBe(1);
  });

  /**
   * `SciArray::copy` resizes the target before moving anything, and Sierra's
   * `Array::copy` relies on it: it makes an empty array and copies into that.
   */
  it('grows the target when copying into a fresh array', () => {
    const { world, heap } = arrayWorld();
    const source = call(world, 0, 4, 0);
    for (const [at, value] of [13, 21, 34, 55].entries()) heap.arrayPut(source, at, value);

    const target = call(world, 0, 0, 0);
    expect(heap.arrayLength(target)).toBe(0);

    // copy(target, 0, source, 0, -1) — the whole of the source, as `copyToFrom`
    // asks for it.
    call(world, 6, asRef(target), 0, asRef(source), 0, 0xffff);
    expect(heap.arrayLength(target)).toBe(4);
    expect([0, 1, 2, 3].map((at) => heap.arrayAt(target, at))).toEqual([13, 21, 34, 55]);
  });

  it('grows when filling and when setting elements past the end', () => {
    const { world, heap } = arrayWorld();
    const filled = call(world, 0, 0, 0);
    call(world, 5, asRef(filled), 0, 3, 7);
    expect([0, 1, 2].map((at) => heap.arrayAt(filled, at))).toEqual([7, 7, 7]);

    const set = call(world, 0, 0, 0);
    call(world, 3, asRef(set), 1, 42, 43);
    expect(heap.arrayLength(set)).toBe(3);
    expect(heap.arrayAt(set, 2)).toBe(43);
  });
});

/**
 * **ScummVM's selector identifiers are not selector names.**
 *
 * `selector.cpp` writes `FIND_SELECTOR2(b_movCnt, "b-moveCnt")`: the first is a
 * C++ field name, which cannot hold a hyphen, and the second is what the game
 * actually calls it. Porting the identifiers as names left all six Bresenham
 * selectors resolving to nothing — and a selector that resolves to nothing
 * reads as zero rather than raising, so every mover silently tested the wrong
 * axis and no mover ever arrived.
 *
 * Checked against the source text rather than by calling anything, because the
 * failure is that the name is never looked up successfully: any test that built
 * its own object would have to name the properties too, and would name them the
 * same wrong way. The fixture in `sci-pmachine.test.ts` did exactly that and
 * agreed with the bug for as long as it existed.
 */
describe('Bresenham selectors are named the way a game names them', () => {
  const source = readFileSync(
    new URL('../src/engine/sci/script/SciKernel.ts', import.meta.url),
    'utf8',
  );

  it('reads the hyphenated vocab names, not ScummVM’s C++ identifiers', () => {
    expect(source).not.toMatch(/'b_(movCnt|i1|i2|di|xAxis|incr)'/);
    for (const name of ['b-moveCnt', 'b-i1', 'b-i2', 'b-di', 'b-xAxis', 'b-incr']) {
      expect(source).toContain(`'${name}'`);
    }
  });
});

/**
 * `NumLoops` and `NumCels` are asked about an **object**, not a View number.
 *
 * ScummVM's `kNumCels` reads the `view` *and* `loop` Selectors off the object
 * it is handed; `kNumLoops` reads `view`. This engine was using the object
 * reference's own heap offset as a View number, so it never found a View and
 * both answered their fallback of one.
 *
 * One is not a harmless fallback. `Cycle::init` sets `lastCel` from it and
 * `CT::init` clamps its target cel down to `lastCel` — so a script asking to
 * cycle to cel 11 got a target of nought, the cel counted upwards past it
 * forever, and the `cue` at the end never came. In King's Quest VII that hung
 * `deathByGila` at its first state, which held the room's script, which stopped
 * the room answering anything at all.
 */
describe('NumLoops and NumCels read the object they are given', () => {
  it('asks the object for its view and its loop', () => {
    const asked: string[] = [];
    const view = {
      loops: [{ cels: [0, 0, 0] }, { cels: [0, 0, 0, 0, 0, 0, 0] }],
    };
    const world = {
      viewLoopCount: () => view.loops.length,
      viewCelCount: () => {
        asked.push('cels');
        return view.loops[1].cels.length;
      },
      log: () => {},
    } as unknown as SciKernelWorld;

    const object = { segment: 3, offset: 4906 } as never;
    expect(SCI_KERNEL.NumLoops(world, [object]).offset).toBe(2);
    // The second loop's count, not the first's — the loops differ on purpose.
    expect(SCI_KERNEL.NumCels(world, [object]).offset).toBe(7);
    expect(asked).toEqual(['cels']);
  });

  it('falls back to one only when there is no view to ask', () => {
    const world = { log: () => {} } as unknown as SciKernelWorld;
    expect(SCI_KERNEL.NumCels(world, [{ segment: 3, offset: 1 } as never]).offset).toBe(1);
  });
});
