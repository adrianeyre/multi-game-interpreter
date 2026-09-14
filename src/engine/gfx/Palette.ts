/**
 * A 256 entry VGA palette plus the colour cycling the rooms drive.
 *
 * SCUMM stores palettes as 256 RGB triples in a room's CLUT chunk. Cycling
 * (CYCL) rotates sub-ranges of that palette on a timer, which is how water
 * ripples, fires flicker and lights blink without any per-frame drawing.
 */

export interface ColorCycle {
  start: number;
  end: number;
  /** Ticks between rotations; smaller is faster. */
  delay: number;
  /** +1 rotates upwards, -1 downwards. */
  direction: number;
  counter: number;
}

export class Palette {
  /** RGBA, 4 bytes per entry, ready to index into when blitting. */
  readonly rgba = new Uint8ClampedArray(256 * 4);
  /** The unmodified room palette, so effects can be undone. */
  private readonly base = new Uint8Array(256 * 3);
  /** Current palette after cycling and darkening. */
  private readonly current = new Uint8Array(256 * 3);

  private cycles: ColorCycle[] = [];

  /** Per-channel intensity in 0..255, as set by roomOps "palette intensity". */
  private readonly intensity = new Uint8Array(256 * 3).fill(0xff);

  private dirty = true;

  constructor() {
    for (let i = 0; i < 256; i++) this.rgba[i * 4 + 3] = 255;
  }

  /**
   * The 256 colours as they stand, as a CLUT payload.
   *
   * The inverse of `setFromClut`, and it exists for one caller: a video borrows
   * every colour and the room underneath needs its own back afterwards. Taken
   * as bytes rather than remembered as "the room's palette" because a room's
   * colours can have been changed by a script since it was entered, and it is
   * what is *on screen* that has to come back.
   */
  snapshot(): Uint8Array {
    return this.current.slice();
  }

  /** Loads 256 RGB triples from a CLUT payload. */
  setFromClut(data: Uint8Array, offset = 0): void {
    const count = Math.min(256, Math.floor((data.length - offset) / 3));
    for (let i = 0; i < count; i++) {
      this.base[i * 3] = data[offset + i * 3];
      this.base[i * 3 + 1] = data[offset + i * 3 + 1];
      this.base[i * 3 + 2] = data[offset + i * 3 + 2];
    }
    this.current.set(this.base);
    this.intensity.fill(0xff);
    this.dirty = true;
  }

  setColor(index: number, r: number, g: number, b: number): void {
    this.base[index * 3] = r;
    this.base[index * 3 + 1] = g;
    this.base[index * 3 + 2] = b;
    this.current[index * 3] = r;
    this.current[index * 3 + 1] = g;
    this.current[index * 3 + 2] = b;
    this.dirty = true;
  }

  getColor(index: number): [number, number, number] {
    return [this.current[index * 3], this.current[index * 3 + 1], this.current[index * 3 + 2]];
  }

  /**
   * Scales a palette range, used by `roomOps` for the darkening that happens
   * when a room's lights go out.
   */
  setIntensity(start: number, end: number, red: number, green: number, blue: number): void {
    for (let i = start; i <= end && i < 256; i++) {
      this.intensity[i * 3] = red;
      this.intensity[i * 3 + 1] = green;
      this.intensity[i * 3 + 2] = blue;
    }
    this.dirty = true;
  }

  setCycles(cycles: ColorCycle[]): void {
    this.cycles = cycles;
    this.dirty = true;
  }

  clearCycles(): void {
    this.cycles = [];
  }

  /**
   * Whether a colour belongs to a cycling range.
   *
   * Asked by the nearest-colour search, which must not answer with a colour
   * that is about to rotate: the caller is picking a fixed index to paint an
   * actor with, and a cycled index would make that actor flicker along with the
   * water. Membership of the range is what counts, not whether the cycle is
   * running — a stopped cycle can start again while the actor is still wearing
   * the colour.
   */
  isCycled(index: number): boolean {
    return this.cycles.some((cycle) => index >= cycle.start && index <= cycle.end);
  }

  /**
   * The palette index closest to a given colour.
   *
   * Scripts that recolour a sprite hand over a true colour and expect an index
   * back, because the screen is 8-bit and the sprite is drawn through the room
   * palette. The search is the original's, and its details matter more than
   * they look:
   *
   * - the weights are 3/6/2 for red/green/blue, an approximation of how much
   *   each channel contributes to perceived brightness, so "closest" means
   *   closest to the eye rather than in the RGB cube;
   * - all three channels are rounded down to a multiple of four before
   *   comparing, matching the six-bit DAC the artwork was authored against, and
   *   this is what lets an exact match be found at all;
   * - an exact match returns straight away, so a colour already in the palette
   *   maps to itself rather than to an equally-weighted neighbour;
   * - index 0 is never a candidate, being the transparent one.
   *
   * `threshold` is a distance the caller will accept, or -1 for "whatever is
   * nearest". When the nearest is further away than that, the original steals
   * an unused palette entry — one reading 252 or more in every channel, which
   * is how the artwork marks a slot as spare — and writes the wanted colour
   * into it. That mutates the palette, which is why this lives here.
   */
  remapColor(
    red: number,
    green: number,
    blue: number,
    threshold: number,
    startColor = 1,
    skipCycled = false,
  ): number {
    const r = Math.min(255, red) & ~3;
    const g = Math.min(255, green) & ~3;
    const b = Math.min(255, blue) & ~3;

    let best = 0;
    let bestWeight = Number.POSITIVE_INFINITY;

    for (let i = startColor; i < 255; i++) {
      if (skipCycled && this.isCycled(i)) continue;

      const ar = this.current[i * 3] & ~3;
      const ag = this.current[i * 3 + 1] & ~3;
      const ab = this.current[i * 3 + 2] & ~3;
      if (ar === r && ag === g && ab === b) return i;

      const weight = colorWeight(ar - r, ag - g, ab - b);
      if (weight < bestWeight) {
        bestWeight = weight;
        best = i;
      }
    }

    if (threshold !== -1 && bestWeight > colorWeight(threshold, threshold, threshold)) {
      for (let i = 254; i > 48; i--) {
        const spare =
          this.current[i * 3] >= 252 &&
          this.current[i * 3 + 1] >= 252 &&
          this.current[i * 3 + 2] >= 252;
        if (spare) {
          this.setColor(i, r, g, b);
          return i;
        }
      }
    }

    return best;
  }

  /** Enables or disables one cycle, as `roomOps` does for e.g. lightning. */
  setCycleEnabled(index: number, enabled: boolean): void {
    const cycle = this.cycles[index];
    if (cycle) cycle.delay = enabled ? cycle.delay || 1 : 0;
  }

  /**
   * Advances colour cycling by one engine tick.
   *
   * Rotation happens on the working copy, not the base, so a room reload or a
   * palette intensity change starts from clean colours.
   */
  /**
   * Advances every colour cycle by `jiffies` sixtieths.
   *
   * A cycle's delay comes out of the room's `CYCL` block as `16384 / rate`,
   * and it is a number of *sixtieths* — so the counter has to be given the
   * length of the cycle rather than the number one. Counted per cycle instead,
   * every rotation took as many sixtieths as the game's cycle rate: Day of the
   * Tentacle's water, neon and flickering lights all ran at a sixth of their
   * speed, which reads as the room being sluggish rather than as a palette
   * fault.
   *
   * The remainder is carried rather than discarded (`counter %= delay`, as the
   * original does) because a cycle length that does not divide the delay would
   * otherwise lose a fraction of a step every rotation and drift slow.
   */
  step(jiffies = 1): void {
    const amount = Math.max(1, jiffies);
    for (const cycle of this.cycles) {
      if (cycle.delay === 0) continue;
      cycle.counter += amount;
      if (cycle.counter < cycle.delay) continue;
      cycle.counter %= cycle.delay;
      this.rotate(cycle.start, cycle.end, cycle.direction);
      this.dirty = true;
    }
  }

  private rotate(start: number, end: number, direction: number): void {
    if (end <= start) return;
    const count = end - start + 1;
    const temp = this.current.slice(start * 3, (end + 1) * 3);
    for (let i = 0; i < count; i++) {
      const from = (((i - direction) % count) + count) % count;
      this.current[(start + i) * 3] = temp[from * 3];
      this.current[(start + i) * 3 + 1] = temp[from * 3 + 1];
      this.current[(start + i) * 3 + 2] = temp[from * 3 + 2];
    }
  }

  /** Rebuilds the RGBA lookup if anything changed. Cheap when nothing did. */
  flush(): void {
    if (!this.dirty) return;
    for (let i = 0; i < 256; i++) {
      // SCUMM palettes are 6 bit VGA values in most releases but the CD
      // re-releases store full 8 bit. Values above 63 mean 8 bit, so scale
      // only when the whole palette looks like 6 bit data.
      this.rgba[i * 4] = (this.current[i * 3] * this.intensity[i * 3]) / 255;
      this.rgba[i * 4 + 1] = (this.current[i * 3 + 1] * this.intensity[i * 3 + 1]) / 255;
      this.rgba[i * 4 + 2] = (this.current[i * 3 + 2] * this.intensity[i * 3 + 2]) / 255;
      this.rgba[i * 4 + 3] = 255;
    }
    this.dirty = false;
  }

  markDirty(): void {
    this.dirty = true;
  }

  /**
   * Detects and corrects 6 bit VGA palettes.
   *
   * Floppy releases store 0-63 per channel because that is what the VGA DAC
   * took; CD releases store 0-255. Scaling a 0-255 palette would blow out the
   * whites, so it is only applied when every entry fits in 6 bits.
   */
  normaliseDepth(): void {
    let max = 0;
    for (let i = 0; i < 256 * 3; i++) if (this.base[i] > max) max = this.base[i];
    if (max === 0 || max > 63) return;
    for (let i = 0; i < 256 * 3; i++) {
      this.base[i] = (this.base[i] * 255) / 63;
    }
    this.current.set(this.base);
    this.dirty = true;
  }
}

/**
 * How far apart two colours look, weighted per channel.
 *
 * Squared, so it is only ever compared against another of the same, never used
 * as a distance in its own right.
 */
function colorWeight(red: number, green: number, blue: number): number {
  return 3 * red * red + 6 * green * green + 2 * blue * blue;
}
