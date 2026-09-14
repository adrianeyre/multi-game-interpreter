/**
 * `GetEvent` when there is nothing to give — which is most cycles.
 *
 * A SCI script asks for an event every cycle and reads the event object
 * whether or not it was given one. Sierra's `kGetEvent` ends in a `default:`
 * that writes a type of none, a message of nought and the current modifiers
 * before answering false; leaving those three alone instead means the cycle
 * after a click is still carrying that click.
 *
 * `ExitFeature::handleEvent` in King's Quest VII is the case that found this:
 * it branches on `type` being nought to mean "no event, just tell me where the
 * pointer is", and that branch is what arms the thing under the cursor.
 */

import { describe, expect, it } from 'vitest';

import { SCI_KERNEL, type SciKernelWorld } from '../src/engine/sci/script/SciKernel.js';
import { SCI_EVENT } from '../src/engine/sci/SciInput.js';

/** An event object whose five selectors this test can read back. */
function eventWorld(queued: Array<Record<string, number>>) {
  const written: Record<string, number> = {
    type: 0xdead,
    message: 0xdead,
    modifiers: 0xdead,
    x: 0xdead,
    y: 0xdead,
  };
  const selectors = ['type', 'message', 'modifiers', 'x', 'y'];
  const object = {
    id: { segment: 1, offset: 1 },
    variables: selectors.map(() => ({ segment: 0, offset: 0 })),
  };
  const world = {
    input: {
      mouseX: 7,
      mouseY: 9,
      next: () => queued.shift() ?? null,
    },
    machine: {
      object: () => object,
      selectorNumbers: new Map(selectors.map((name, index) => [name, index])),
      resolveProperty: (_o: unknown, selector: number) => selector,
    },
    log: () => {},
  } as unknown as SciKernelWorld;
  // The kernel writes through `setProperty`, which goes to `variables`.
  return {
    world,
    read: (name: string) => object.variables[selectors.indexOf(name)]?.offset,
    written,
  };
}

describe('GetEvent with nothing to give', () => {
  it('writes a null event out rather than leaving the last one behind', () => {
    const { world, read } = eventWorld([
      { type: SCI_EVENT.mouseDown, message: 42, modifiers: 3, x: 100, y: 120 },
    ]);
    const target = { segment: 1, offset: 1 } as never;

    // The real event arrives and is written.
    expect(
      SCI_KERNEL.GetEvent(world, [{ segment: 0, offset: 0x7fff } as never, target]).offset,
    ).toBe(1);
    expect(read('type')).toBe(SCI_EVENT.mouseDown);
    expect(read('message')).toBe(42);
    expect(read('modifiers')).toBe(3);

    // The very next cycle has nothing. Sierra writes a null event here; this
    // used to write only x and y, so `type` still said a button was down.
    expect(
      SCI_KERNEL.GetEvent(world, [{ segment: 0, offset: 0x7fff } as never, target]).offset,
    ).toBe(0);
    expect(read('type')).toBe(SCI_EVENT.none);
    expect(read('message')).toBe(0);
    expect(read('modifiers')).toBe(0);
    // And the pointer is still reported, which is the one thing a null event
    // does carry.
    expect(read('x')).toBe(7);
    expect(read('y')).toBe(9);
  });
});

/**
 * The event type bits, against ScummVM's `SciEventType`.
 *
 * These are a **mask**, and a wrong bit is silent: the game still runs and
 * takes a branch it never meant to. King's Quest VII's own exits branch on
 * `type & 0x1000`, so an engine that can set bit twelve is an engine that can
 * send that game somewhere it was not sent.
 */
describe('the SCI event type bits', () => {
  it('matches the bits ScummVM assigns', () => {
    expect(SCI_EVENT.none).toBe(0);
    expect(SCI_EVENT.mouseDown).toBe(1);
    expect(SCI_EVENT.mouseUp).toBe(1 << 1);
    expect(SCI_EVENT.keyDown).toBe(1 << 2);
    expect(SCI_EVENT.keyUp).toBe(1 << 3);
    // SCI32 and SCI16 number a direction event differently, and both are kept.
    expect(SCI_EVENT.direction32).toBe(1 << 4);
    expect(SCI_EVENT.direction16).toBe(1 << 6);
    expect(SCI_EVENT.saidSomething).toBe(1 << 7);
    expect(SCI_EVENT.hotRectangle).toBe(1 << 10);
    // Bit eleven. This was bit twelve, which belongs to no SCI event.
    expect(SCI_EVENT.quit).toBe(1 << 11);
    expect(SCI_EVENT.peek).toBe(1 << 15);
  });

  it('gives no two different events the same bit', () => {
    const byBit = new Map<number, string[]>();
    for (const [name, bit] of Object.entries(SCI_EVENT)) {
      if (bit === 0) continue;
      byBit.set(bit, [...(byBit.get(bit) ?? []), name]);
    }
    // `movement` is kept as an alias of `direction16`, and aliases are allowed;
    // anything else sharing a bit is two events the mask cannot tell apart.
    const shared = [...byBit.values()].filter((names) => names.length > 1);
    expect(shared).toEqual([['direction16', 'movement']]);
  });
});
