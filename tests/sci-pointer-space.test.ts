/**
 * Which coordinate space a SCI pointer event is in, and who converts.
 *
 * **A SCI script has only ever seen one space, and it is not the screen's.**
 * SCI16 draws 320x200 and its scripts speak 320x200, so the two were one number
 * and nothing had to say which. SCI32 composites to 640x480 and its scripts
 * still speak 320x200 — so every click has to be mapped, exactly once.
 *
 * Exactly once is the whole of this file. Two callers arrive here in two
 * different spaces:
 *
 * - a **browser** goes through `InputSurface.toScreen`, which `main.ts` maps
 *   through `engine.resolution.script` — so it is *already* in the script's
 *   space;
 * - a **diagnostic** has no surface and aims at the framebuffer a person is
 *   looking at in a PNG, so it passes display pixels.
 *
 * Converting the browser's click a second time halved it: a click on King's
 * Quest VII's menu at script (117, 88) arrived as (58, 36) and missed
 * everything, with nothing reporting a fault. That is the regression this
 * holds, and it is worth a test because both readings look right in isolation.
 */

import { describe, expect, it } from 'vitest';

import { SCI_EVENT, SciInput } from '../src/engine/sci/SciInput.js';

/** An input with SCI32's two spaces set, as `SciEngine` sets them. */
function sci32Input(): SciInput {
  const input = new SciInput();
  input.displaySize = { width: 640, height: 480 };
  input.scriptSize = { width: 320, height: 200 };
  return input;
}

describe('a pointer reaches the scripts in the space they think in', () => {
  /**
   * The diagnostic path: display pixels in, script coordinates out. A person
   * aiming at a 640x480 PNG should be able to pass what they measured off it.
   */
  it('maps a posted event out of the framebuffer and into the script', () => {
    const input = sci32Input();
    input.post({ type: SCI_EVENT.mouseDown, message: 0, modifiers: 0, x: 234, y: 211 });
    expect({ x: input.mouseX, y: input.mouseY }).toEqual({ x: 117, y: 88 });
  });

  it('moves the pointer the same way, without queueing an event', () => {
    const input = sci32Input();
    input.moveTo(640, 480);
    expect({ x: input.mouseX, y: input.mouseY }).toEqual({ x: 320, y: 200 });
    // A move is not an event: the queue is bounded at 32 and moves would push
    // every click out of it.
    expect(input.next(0xffff)).toBeNull();
  });

  /**
   * The browser path, and the one that regressed. `toScreen` has already
   * answered in the script's space, so what it says is what the scripts get.
   */
  it('does not convert a click that arrived through the surface a second time', () => {
    const input = sci32Input();
    const canvas = new EventTarget() as unknown as HTMLCanvasElement;
    input.attach({
      canvas,
      keys: new EventTarget() as unknown as HTMLElement,
      overlay: null,
      // Already script coordinates, which is what `main.ts` returns.
      toScreen: () => ({ x: 117, y: 88 }),
      resumeSound: () => undefined,
    } as never);

    canvas.dispatchEvent(
      Object.assign(new Event('pointerdown'), { clientX: 0, clientY: 0, preventDefault() {} }),
    );

    expect({ x: input.mouseX, y: input.mouseY }).toEqual({ x: 117, y: 88 });
    const event = input.next(0xffff);
    expect(event).toMatchObject({ x: 117, y: 88 });
  });

  /** A SCI16 game's two spaces are the same, so nothing moves either way. */
  it('leaves a SCI16 pointer alone, where the two spaces are one', () => {
    const input = new SciInput();
    input.displaySize = { width: 320, height: 200 };
    input.scriptSize = { width: 320, height: 200 };
    input.post({ type: SCI_EVENT.mouseDown, message: 0, modifiers: 0, x: 200, y: 150 });
    expect({ x: input.mouseX, y: input.mouseY }).toEqual({ x: 200, y: 150 });
  });
});
