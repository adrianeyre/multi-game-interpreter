/**
 * SCI16's `Palette` Kernel call: what a script does to the colours directly.
 *
 * `PalVary` fades toward a resource and `PalCycle` rotates a band; this is the
 * rest — load a palette resource, mark entries in use, dim a range, find the
 * nearest colour, rotate a range on a timer, and save and restore the lot.
 * All of it answered nought before, and two of those answers change what a
 * game believes rather than only what it shows: `FindColor` is how a VGA game
 * picks the index for "black" or "white" out of a palette it did not author,
 * and `Save` is a handle a game hands back to `Restore` after a flash.
 *
 * Transcribed from ScummVM's `GfxPalette` (`engines/sci/graphics/palette16.cpp`)
 * and `kPalette*` (`engines/sci/engine/kgraphics.cpp`), fetched 2026-09-27.
 *
 * **Over the shared `Palette`, not a second copy of it.** The colours on
 * screen are `Palette`'s; this keeps only what SCI adds on top — the `used`
 * flag per entry, the intensity percentage, and the animation schedules —
 * so a `FindColor` after a `PalVary` step sees the colours the player sees.
 */

import type { Palette } from '../../gfx/Palette.js';

/** `SCI_PALETTE_MATCH_*`: the perfect-match bit ScummVM ors in and masks off. */
const MATCH_COLOUR_MASK = 0xff;

export class SciPalette16 {
  /**
   * Sierra's `used` byte per entry. Every entry counts as in use until a
   * script says otherwise, because a loaded palette marks every colour it
   * carries and this engine has no record of which entries a resource left
   * blank.
   */
  readonly used = new Uint8Array(256).fill(1);
  /** `_sysPalette.intensity`, a percentage per entry. */
  readonly intensity = new Uint8Array(256).fill(100);

  private readonly palette: Palette;
  /** `_schedules`: when each animated range next rotates, keyed by its first entry. */
  private readonly schedules = new Map<number, number>();

  constructor(palette: Palette) {
    this.palette = palette;
  }

  /** `kernelSetFlag`: `[from, to)`, clipped to 1..255 by the Kernel call. */
  setFlag(from: number, to: number, flag: number): void {
    for (let index = clip(from); index < clip(to); index++) this.used[index] |= flag;
  }

  unsetFlag(from: number, to: number, flag: number): void {
    for (let index = clip(from); index < clip(to); index++) this.used[index] &= ~flag & 0xff;
  }

  /**
   * `kernelSetIntensity`: a percentage over `[from, to)`, applied to what is
   * shown and not to the colours themselves — so a fade to nought and back
   * returns every colour exactly.
   */
  setIntensity(from: number, to: number, percent: number): void {
    const start = clip(from);
    const end = clip(to);
    for (let index = start; index < end; index++) this.intensity[index] = percent & 0xff;
    if (end > start) {
      const scale = Math.max(0, Math.min(255, Math.round(((percent & 0xff) * 255) / 100)));
      this.palette.setIntensity(start, end - 1, scale, scale, scale);
    }
  }

  /**
   * `matchColor` over the entries in use: the smallest summed channel
   * distance, and the **last** of equals, because Sierra's comparison is
   * `<=`. SCI1.1 from Quest for Glory 3 on wraps each difference through a
   * signed byte, which ScummVM keeps because the games' colours depend on it.
   */
  findColor(r: number, g: number, b: number, wrapped = false): number {
    let best = 0x7fff;
    let found = 255;
    for (let index = 0; index < 256; index++) {
      if (!this.used[index]) continue;
      const [red, green, blue] = this.palette.getColor(index);
      const distance = wrapped
        ? byteDistance(red, r) + byteDistance(green, g) + byteDistance(blue, b)
        : Math.abs(red - r) + Math.abs(green - g) + Math.abs(blue - b);
      if (distance <= best) {
        best = distance;
        found = index;
      }
    }
    return found & MATCH_COLOUR_MASK;
  }

  /**
   * SCI32's `GfxPalette32::matchColor`: the smallest *squared* distance, the
   * first of equals, and only below the remap range — 236 is where SCI32's
   * remapping starts by default, and a remap colour is not a colour to match.
   */
  findColor32(r: number, g: number, b: number, limit = 236): number {
    let best = 0xfffff;
    let found = 0;
    for (let index = 0; index < limit; index++) {
      const [red, green, blue] = this.palette.getColor(index);
      const distance = (red - r) ** 2 + (green - g) ** 2 + (blue - b) ** 2;
      if (distance < best) {
        best = distance;
        found = index;
      }
    }
    return found;
  }

  /**
   * `kernelAnimate`: rotate `[from, to)` one step once `|speed|` ticks have
   * passed since it last did, downward for a positive speed. The first call
   * for a range only schedules it. Answers whether anything moved.
   */
  animate(from: number, to: number, speed: number, now: number): boolean {
    const due = this.schedules.get(from);
    if (due === undefined) {
      this.schedules.set(from, now + Math.abs(speed));
      return false;
    }
    if (due > now) return false;
    if (to - 1 < from) return false;

    const colours = [];
    for (let index = from; index < to; index++) colours.push(this.palette.getColor(index));
    const rotated =
      speed > 0
        ? [...colours.slice(1), colours[0]]
        : [colours[colours.length - 1], ...colours.slice(0, -1)];
    rotated.forEach(([r, g, b], offset) => this.palette.setColor(from + offset, r, g, b));
    this.schedules.set(from, now + Math.abs(speed));
    return true;
  }

  /**
   * `GfxPalette::merge` with a real merge forced, as a portrait's palette is
   * set: each colour takes an entry that already holds it exactly, else the
   * first entry nothing uses (which it then uses), else the nearest. Answers
   * where each of `colours` ended up.
   */
  merge(colours: ReadonlyArray<readonly [number, number, number]>): Uint8Array {
    const mapping = new Uint8Array(256);
    colours.forEach(([r, g, b], index) => {
      for (let at = 0; at < 256; at++) {
        if (!this.used[at]) continue;
        const [red, green, blue] = this.palette.getColor(at);
        if (red === r && green === g && blue === b) {
          mapping[index] = at;
          return;
        }
      }
      const free = this.used.indexOf(0);
      if (free > 0) {
        this.palette.setColor(free, r, g, b);
        this.used[free] = 1;
        mapping[index] = free;
        return;
      }
      mapping[index] = this.findColor(r, g, b);
    });
    return mapping;
  }

  /** `kernelSave`: 1024 bytes, `used, r, g, b` per entry. */
  save(): Uint8Array {
    const bytes = new Uint8Array(1024);
    for (let index = 0; index < 256; index++) {
      const [r, g, b] = this.palette.getColor(index);
      bytes.set([this.used[index], r, g, b], index * 4);
    }
    return bytes;
  }

  /** `kernelRestore`: the block `save` wrote, back into the palette. */
  restore(bytes: Uint8Array): void {
    for (let index = 0; index < 256 && index * 4 + 3 < bytes.length; index++) {
      this.used[index] = bytes[index * 4];
      this.palette.setColor(
        index,
        bytes[index * 4 + 1],
        bytes[index * 4 + 2],
        bytes[index * 4 + 3],
      );
    }
  }
}

function clip(index: number): number {
  return Math.max(1, Math.min(255, index));
}

/** `(uint8)ABS<int8>(a - b)`: the difference wrapped through a signed byte. */
function byteDistance(a: number, b: number): number {
  let difference = (a - b) & 0xff;
  if (difference >= 0x80) difference -= 0x100;
  return Math.abs(difference) & 0xff;
}
