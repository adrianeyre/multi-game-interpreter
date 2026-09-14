/**
 * `PalVary` — a palette fading into another over time.
 *
 * A SCI1.1 game uses it for a room going dark, a sunset, a lightning flash: it
 * names a target palette and a number of ticks, and the interpreter walks the
 * current palette towards it one step at a time while the game carries on.
 *
 * **A state machine rather than a renderer**, so that the arithmetic can be
 * tested without a screen. The engine owns the palette and the clock; this owns
 * where the fade has got to, and `colourAt` says what a given entry should be
 * at the current step.
 *
 * Sixty-four steps, always, whatever the tick count — the step is the position
 * in the blend and the ticks are how long each one lasts, which is why
 * `getCurrentStep` answers something a script can compare against 64.
 * Transcribed from `GfxPalette::kernelPalVaryInit` and `palVaryProcess`
 * (`engines/sci/graphics/palette16.cpp:735,884`), fetched 2026-09-13.
 */

/** A palette entry as the SCI16 palette holds one. */
export interface SciPalVaryColour {
  r: number;
  g: number;
  b: number;
}

/** The sub-function numbers `PalVary` dispatches on (`kernel_tables.h:271`). */
export const SCI_PAL_VARY = {
  init: 0,
  reverse: 1,
  getCurrentStep: 2,
  deinit: 3,
  changeTarget: 4,
  changeTicks: 5,
  pauseResume: 6,
} as const;

/** The blend is over sixty-four steps whatever the tick count. */
const STEPS = 64;

export class SciPalVary {
  /** The palette being faded to, or -1 when no fade is running. */
  private resource = -1;

  private origin: SciPalVaryColour[] = [];

  private target: SciPalVaryColour[] = [];

  private step = 0;

  private stepStop = STEPS;

  private direction = 1;

  private ticks = 0;

  private sinceStep = 0;

  private paused = false;

  /** Whether a fade is running, which is what `Deinit` and step 0 end. */
  get running(): boolean {
    return this.resource !== -1;
  }

  get currentStep(): number {
    return this.step;
  }

  /**
   * Starts a fade, answering false when one is already running.
   *
   * **Refusing rather than replacing is Sierra's** (`palette16.cpp:736`): a
   * second `Init` while a fade is in flight returns without touching anything,
   * and the script is expected to notice. Replacing would make two overlapping
   * fades silently become the second one.
   */
  init(
    resource: number,
    origin: readonly SciPalVaryColour[],
    target: readonly SciPalVaryColour[],
    ticks: number,
    stepStop = STEPS,
    direction = 1,
  ): boolean {
    if (this.running) return false;

    this.resource = resource;
    this.origin = origin.map((colour) => ({ ...colour }));
    this.target = target.map((colour) => ({ ...colour }));
    this.step = 1;
    this.stepStop = stepStop;
    this.direction = direction;
    this.ticks = ticks;
    this.sinceStep = 0;
    this.paused = false;

    // No ticks means "be there now": the direction becomes the whole distance,
    // so the first process lands on the stop.
    if (ticks === 0) this.direction = stepStop;
    return true;
  }

  /** Turns the fade round, answering the step it had got to. */
  reverse(ticks = -1, stepStop = 0, direction = -1): number {
    if (!this.running) return 0;

    if (this.step > STEPS) this.step = STEPS;
    if (ticks !== -1) this.ticks = ticks;
    this.stepStop = stepStop;
    this.direction = direction !== -1 ? -direction : -this.direction;
    if (this.ticks === 0) this.direction = this.stepStop - this.step;
    return this.step;
  }

  /** Points the fade at another palette, answering where it had got to. */
  changeTarget(resource: number, target: readonly SciPalVaryColour[]): number {
    if (!this.running) return 0;
    this.resource = resource;
    this.target = target.map((colour) => ({ ...colour }));
    return this.step;
  }

  changeTicks(ticks: number): void {
    this.ticks = ticks;
  }

  pause(paused: boolean): void {
    this.paused = paused;
  }

  deinit(): void {
    this.resource = -1;
    this.step = 0;
  }

  /**
   * Advances the clock, answering whether the palette changed.
   *
   * The caller ticks this once a cycle; a step happens every `ticks` of them.
   * Nought ticks is the "jump there" case and steps on the first advance, which
   * is what `init` set the direction up for.
   */
  advance(ticks = 1): boolean {
    if (!this.running || this.paused) return false;

    this.sinceStep += ticks;
    if (this.ticks > 0 && this.sinceStep < this.ticks) return false;
    this.sinceStep = 0;

    const before = this.step;
    const change = this.direction;
    this.step += change;

    if (change > 0) {
      if (this.step > this.stepStop) this.step = this.stepStop;
    } else if (this.step < this.stepStop) {
      this.step = this.stepStop;
    }

    // At the stop the fade has arrived; at nought it is back where it began and
    // there is nothing left to fade from.
    if (this.step === 0) this.resource = -1;
    return this.step !== before;
  }

  /**
   * What an entry should be at the step the fade has reached.
   *
   * `((target - origin) * step) / 64 + origin`, per channel, truncating —
   * `palVaryProcess` does it in integers and the rounding is visible as a
   * one-off in a dark palette.
   */
  colourAt(index: number): SciPalVaryColour | null {
    const from = this.origin[index];
    const to = this.target[index];
    if (!from || !to) return null;
    const blend = (a: number, b: number): number => Math.trunc(((b - a) * this.step) / STEPS) + a;
    return { r: blend(from.r, to.r), g: blend(from.g, to.g), b: blend(from.b, to.b) };
  }

  /** How many entries the fade covers, which is the shorter of the two. */
  get length(): number {
    return Math.min(this.origin.length, this.target.length);
  }
}
