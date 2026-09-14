/**
 * `PalVary` — the palette fade, checked as arithmetic rather than as pixels.
 *
 * The state machine is deliberately separate from the palette it drives, so
 * what a fade is halfway through can be asserted without a screen. Every
 * expectation below is worked from `palVaryProcess`
 * (`engines/sci/graphics/palette16.cpp:884`) rather than from what this code
 * happens to produce.
 */

import { describe, expect, it } from 'vitest';

import { SciPalVary, SCI_PAL_VARY } from '../src/engine/sci/gfx/sciPalVary.js';

/** Two palettes a step apart in each channel, so a blend is readable by eye. */
const black = Array.from({ length: 4 }, () => ({ r: 0, g: 0, b: 0 }));
const white = Array.from({ length: 4 }, () => ({ r: 64, g: 128, b: 256 - 1 }));

describe('a fade between two palettes', () => {
  it('blends in sixty-fourths of the distance, truncating', () => {
    const vary = new SciPalVary();
    // Thirty-two ticks a step is irrelevant to the arithmetic; the step is the
    // position in the blend and 64 is always the whole of it.
    expect(vary.init(7, black, white, 0, 64, 1)).toBe(true);

    // Step 1 of 64: one sixty-fourth of the way.
    expect(vary.colourAt(0)).toEqual({ r: 1, g: 2, b: 3 });
  });

  it('refuses a second fade rather than replacing the one running', () => {
    const vary = new SciPalVary();
    expect(vary.init(7, black, white, 30)).toBe(true);
    // Sierra returns without touching anything (`palette16.cpp:736`); two
    // overlapping fades silently becoming the second is worse than a no.
    expect(vary.init(8, white, black, 30)).toBe(false);
  });

  it('jumps to the stop on the first advance when no ticks were given', () => {
    const vary = new SciPalVary();
    vary.init(7, black, white, 0, 64, 1);
    expect(vary.advance()).toBe(true);
    expect(vary.currentStep).toBe(64);
    // Arrived: every channel is the target's.
    expect(vary.colourAt(0)).toEqual({ r: 64, g: 128, b: 255 });
  });

  it('waits out the tick count before each step', () => {
    const vary = new SciPalVary();
    vary.init(7, black, white, 3, 64, 1);
    expect(vary.advance()).toBe(false);
    expect(vary.advance()).toBe(false);
    expect(vary.advance()).toBe(true);
    expect(vary.currentStep).toBe(2);
  });

  it('stops at the step it was told to stop at', () => {
    const vary = new SciPalVary();
    vary.init(7, black, white, 1, 3, 1);
    vary.advance();
    vary.advance();
    vary.advance();
    vary.advance();
    expect(vary.currentStep).toBe(3);
  });

  it('turns round, and answers the step it had reached', () => {
    const vary = new SciPalVary();
    vary.init(7, black, white, 1, 64, 1);
    vary.advance();
    vary.advance();
    expect(vary.currentStep).toBe(3);
    expect(vary.reverse(1, 0, -1)).toBe(3);
    vary.advance();
    expect(vary.currentStep).toBe(2);
  });

  it('ends when it reaches step nought, which is where it began', () => {
    const vary = new SciPalVary();
    vary.init(7, black, white, 1, 64, 1);
    vary.advance();
    expect(vary.currentStep).toBe(2);

    // Reversed to stop at nought, which is the fade running backwards out of
    // existence — a room coming back up to full light.
    vary.reverse(1, 0, -1);
    vary.advance();
    vary.advance();
    expect(vary.currentStep).toBe(0);
    expect(vary.running).toBe(false);
  });

  it('does not move at all when no ticks and a stop of nought make the direction nought', () => {
    const vary = new SciPalVary();
    // `if (!_palVaryTicks) _palVaryDirection = stepStop` (`palette16.cpp:751`),
    // so this pair asks for a jump of nothing and gets one. Worth pinning
    // because it reads like a fade that should end and is a fade that stands
    // still.
    vary.init(7, black, white, 0, 0, 1);
    vary.advance();
    expect(vary.currentStep).toBe(1);
    expect(vary.running).toBe(true);
  });

  it('stops advancing while paused', () => {
    const vary = new SciPalVary();
    vary.init(7, black, white, 1, 64, 1);
    vary.pause(true);
    expect(vary.advance()).toBe(false);
    vary.pause(false);
    expect(vary.advance()).toBe(true);
  });

  it('answers nothing for an entry neither palette has', () => {
    const vary = new SciPalVary();
    vary.init(7, black, white, 1);
    expect(vary.colourAt(99)).toBeNull();
  });
});

describe('the seven sub-functions', () => {
  /** The numbers are Sierra's (`kernel_tables.h:271`) and scripts pass them. */
  it('are numbered as Sierra numbered them', () => {
    expect(SCI_PAL_VARY).toEqual({
      init: 0,
      reverse: 1,
      getCurrentStep: 2,
      deinit: 3,
      changeTarget: 4,
      changeTicks: 5,
      pauseResume: 6,
    });
  });

  it('answers a signal on init and nought when one is already running', async () => {
    const { SCI_KERNEL } = await import('../src/engine/sci/script/SciKernel.js');
    const { reg } = await import('../src/engine/sci/script/PMachine.js');

    const vary = new SciPalVary();
    const world = {
      log: () => undefined,
      palVary: {
        init: (resource: number, ticks: number, stepStop: number, direction: number) =>
          vary.init(resource, black, white, ticks, stepStop, direction),
        reverse: (t: number, s: number, d: number) => vary.reverse(t, s, d),
        currentStep: () => vary.currentStep,
        deinit: () => vary.deinit(),
        changeTarget: (resource: number) => vary.changeTarget(resource, white),
        changeTicks: (t: number) => vary.changeTicks(t),
        pause: (paused: boolean) => vary.pause(paused),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const init = [reg(0, SCI_PAL_VARY.init), reg(0, 7), reg(0, 30)];
    // `SIGNAL_REG` is 0xffff in segment nought, not one.
    expect(SCI_KERNEL.PalVary!(world, init).offset).toBe(0xffff);
    expect(SCI_KERNEL.PalVary!(world, init).offset).toBe(0);

    expect(SCI_KERNEL.PalVary!(world, [reg(0, SCI_PAL_VARY.getCurrentStep)]).offset).toBe(1);

    SCI_KERNEL.PalVary!(world, [reg(0, SCI_PAL_VARY.deinit)]);
    expect(vary.running).toBe(false);
  });

  it('says so rather than guessing when a script passes a sub-function nobody defined', async () => {
    const { SCI_KERNEL } = await import('../src/engine/sci/script/SciKernel.js');
    const { reg } = await import('../src/engine/sci/script/PMachine.js');
    const logged: string[] = [];
    const world = {
      log: (line: string) => logged.push(line),
      palVary: {
        init: () => false,
        reverse: () => 0,
        currentStep: () => 0,
        deinit: () => undefined,
        changeTarget: () => 0,
        changeTicks: () => undefined,
        pause: () => undefined,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    SCI_KERNEL.PalVary!(world, [reg(0, 9)]);
    expect(logged.join(' ')).toMatch(/not one of the seven/);
  });
});
