import type { ColorCycle, Palette } from './Palette.js';

/**
 * How many numbered tables v7 keeps. v5 and v6 keep one.
 *
 * `NUM_SHADOW_PALETTE` in the reference. The number matters beyond storage:
 * shadow mode 3 picks a table with the *source* colour, so the eight darkest
 * indices of a sprite are eight different shades, and a build with fewer
 * tables would shade some of them through whatever sat past the end.
 */
export const V7_SHADOW_SLOTS = 8;

const TABLE_SIZE = 256;

/**
 * The costume colour that means "shade whatever is underneath".
 *
 * Not a palette entry the artwork paints with: a classic costume or an AKOS
 * cel drawn in index 13 (after the actor's palette has been applied) takes the
 * destination pixel and looks it up in the shadow table instead, which is how a
 * character casts a soft shadow on the floor without the costume knowing what
 * floor it is standing on.
 */
export const SHADOW_COLOUR = 13;

/**
 * A SCUMM shadow palette: a colour-to-colour table the renderers look the
 * *destination* pixel up in, so a sprite can darken what is behind it rather
 * than paint over it.
 *
 * The table is the reference's `_shadowPalette`, and it is one array serving
 * three quite different purposes depending on the version:
 *
 * - **v3/v4** write it one slot at a time (`roomOps` 4) and it is applied when
 *   the palette is uploaded — index *i* is displayed as colour `table[i]` —
 *   which is how those games swap a colour for the whole screen at once
 *   (`_shadowPalRemap` and `updatePalette`). v4's colour cycling works by
 *   rewriting it too (`advanceSmallHeaderCycle`).
 * - **v5/v6** build it in one go by nearest-colour matching a scaled copy of
 *   the room's palette (`setShadowPalette(r, g, b, startColor, endColor,
 *   start, end)`), and costume colour 13 then shades through it.
 * - **v7** keeps eight of them, each built from the current palette through
 *   the same search `remapPaletteColor` uses, and shadow mode 3 picks one per
 *   source colour.
 *
 * Held as a plain `Uint8Array` so the renderers index it without a call per
 * pixel, and so a saved game can store it as numbers.
 */
export class ShadowPalette {
  readonly table: Uint8Array;
  readonly slots: number;

  constructor(private readonly version: number) {
    this.slots = version >= 7 ? V7_SHADOW_SLOTS : 1;
    this.table = new Uint8Array(this.slots * TABLE_SIZE);
    this.resetForRoom();
  }

  /**
   * What a room starts with (`startScene`).
   *
   * Before v7, identity: every colour shades to itself, so a costume's colour
   * 13 draws as though it were not there until a script asks for a shadow.
   * v7 clears every table to black instead — the reference's own comment is
   * that shadows tend to be rather black — so a mode-3 sprite drawn before its
   * room has built a table comes out dark rather than invisible.
   */
  resetForRoom(): void {
    if (this.version >= 7) {
      this.table.fill(0);
      return;
    }
    for (let i = 0; i < this.table.length; i++) this.table[i] = i & 0xff;
  }

  /** Whether every table is identity, which is what lets a caller skip it. */
  isIdentity(): boolean {
    for (let i = 0; i < this.table.length; i++) if (this.table[i] !== (i & 0xff)) return false;
    return true;
  }

  /** The v3/v4 form: one entry at a time (`o5_roomOps` sub-opcode 4, small header). */
  setEntry(index: number, colour: number): void {
    if (index < 0 || index >= TABLE_SIZE) return;
    this.table[index] = colour & 0xff;
  }

  /**
   * The v5/v6 form (`setShadowPalette` with seven arguments).
   *
   * For every colour in `[from, to)`, scale the room's own colour by the three
   * 8.8 multipliers and take the closest colour in `[startColor, endColor]` as
   * its shade. Three details are the original's and are worth keeping:
   *
   * - the channels are taken down to six bits before anything else, as the
   *   VGA DAC saw them, so two colours the artwork could not tell apart shade
   *   the same way;
   * - "closest" is the plain sum of the channel differences, not the weighted
   *   distance `remapPaletteColor` uses — this is a separate, older search;
   * - the first best wins ties, and nothing ever matches worse than the
   *   starting score, so an empty range shades every colour to 0.
   *
   * Colours outside `[from, to)` keep whatever they were, unless `resetFirst`
   * says otherwise: Sam & Max starts from identity every time, and the other
   * v6 games layer one call over the previous.
   */
  buildMatched(
    palette: Palette,
    redScale: number,
    greenScale: number,
    blueScale: number,
    startColor: number,
    endColor: number,
    from = 0,
    to = TABLE_SIZE,
    resetFirst = false,
  ): void {
    if (resetFirst) for (let i = 0; i < TABLE_SIZE; i++) this.table[i] = i;

    const last = Math.min(endColor, TABLE_SIZE - 1);
    for (let i = Math.max(0, from); i < Math.min(to, TABLE_SIZE); i++) {
      const [pr, pg, pb] = palette.getBaseColor(i);
      const r = ((pr >> 2) * redScale) >> 8;
      const g = ((pg >> 2) * greenScale) >> 8;
      const b = ((pb >> 2) * blueScale) >> 8;

      let best = 0;
      let bestSum = 32000;
      for (let j = Math.max(0, startColor); j <= last; j++) {
        const [ar, ag, ab] = palette.getBaseColor(j);
        const sum = Math.abs((ar >> 2) - r) + Math.abs((ag >> 2) - g) + Math.abs((ab >> 2) - b);
        if (sum < bestSum) {
          bestSum = sum;
          best = j;
        }
      }
      this.table[i] = best;
    }
  }

  /**
   * The v7 form (`setShadowPalette(slot, ...)`).
   *
   * The whole table starts from identity, and only `[startColor, endColor]` is
   * rebuilt: each colour of the *current* palette scaled by the three 8.8
   * multipliers and matched back through `remapColor` — the same search the
   * actor recolouring uses, cycled colours excluded in v7, because a shadow
   * that rotated with the water would flicker. v8 searches from colour 24 and
   * no longer excludes them.
   *
   * Returns false for a slot or range the original treats as a fatal script
   * error, so the caller can say so rather than write past a table.
   */
  buildScaled(
    palette: Palette,
    slot: number,
    redScale: number,
    greenScale: number,
    blueScale: number,
    startColor: number,
    endColor: number,
  ): boolean {
    if (slot < 0 || slot >= this.slots) return false;
    if (startColor < 0 || endColor > 255 || endColor < startColor) return false;

    const base = slot * TABLE_SIZE;
    for (let i = 0; i < TABLE_SIZE; i++) this.table[base + i] = i;
    for (let i = startColor; i <= endColor; i++) {
      const [r, g, b] = palette.getColor(i);
      this.table[base + i] = palette.remapColor(
        (r * redScale) >> 8,
        (g * greenScale) >> 8,
        (b * blueScale) >> 8,
        -1,
        // v8 reserves more of the low end and no longer refuses cycled
        // colours; v7 searches from 1 and skips them (`remapPaletteColor`).
        this.version === 8 ? 24 : 1,
        this.version === 7,
      );
    }
    return true;
  }

  /**
   * Keeps the tables pointing at the same colours while a cycle rotates them
   * (`doCycleIndirectPalette`).
   *
   * A cycle moves the colour at *c* to *c + 1*. A table entry that named *c*
   * has to follow it or the shadow of a rippling pool stops rippling, and the
   * entries *for* the cycled colours rotate the same way the colours did.
   */
  cycle(start: number, end: number, direction: number): void {
    if (end <= start) return;
    const count = end - start + 1;
    const offset = direction > 0 ? 1 : count - 1;
    for (let slot = 0; slot < this.slots; slot++) {
      const base = slot * TABLE_SIZE;
      for (let i = 0; i < TABLE_SIZE; i++) {
        const value = this.table[base + i];
        if (value >= start && value <= end) {
          this.table[base + i] = ((value - start + offset) % count) + start;
        }
      }
      const rotated = this.table.slice(base + start, base + end + 1);
      for (let i = 0; i < count; i++) {
        const from = (((i - direction) % count) + count) % count;
        this.table[base + start + i] = rotated[from];
      }
    }
  }

  /**
   * v4's colour cycling, which moves nothing in the palette itself
   * (`cyclePalette`'s `GF_SMALL_HEADER` branch, verified by ScummVM against
   * the Loom CD and MI1 VGA executables).
   *
   * A small-header game cycles by rewriting its shadow table — the one the
   * palette upload reads, so index *i* is shown as colour `table[i]` — and the
   * colours stay where the room put them. Each call steps the cycle's position
   * one on (wrapping from `end` to `start`) and lays the range out downwards
   * from it, so the index that showed colour *c* last frame shows *c + 1* now.
   *
   * Three things follow from the cycle's `counter` being that position, and
   * they are the original's:
   *
   * - it advances once per call, not once per `delay`: the rate the room
   *   stores only decides whether the slot is live at all (`initCycl`), and
   *   the cycle then runs at the frame rate;
   * - a counter of zero means "not cycling", so a range that starts at colour
   *   0 never cycles, because its counter starts there;
   * - a slot written by `roomOps` 4 inside a cycling range is overwritten on
   *   the next frame.
   */
  advanceSmallHeaderCycle(cycle: ColorCycle): void {
    if (cycle.counter === 0) return;
    cycle.counter++;
    if (cycle.counter > cycle.end) cycle.counter = cycle.start;
    if (cycle.start > cycle.end || cycle.end >= TABLE_SIZE) return;

    let value = cycle.counter;
    for (let i = cycle.start; i <= cycle.end; i++) {
      this.table[i] = value--;
      if (value < cycle.start) value = cycle.end;
    }
  }

  /** The saved form: plain numbers. */
  save(): number[] {
    return Array.from(this.table);
  }

  /** Puts a saved table back, ignoring one written for a different slot count. */
  restore(saved: readonly number[] | undefined): void {
    if (!saved || saved.length !== this.table.length) return;
    this.table.set(saved);
  }
}

/**
 * How one sprite pixel is shaded, or `null` when it is drawn as it is.
 *
 * The rule lives here rather than in each renderer because costumes, AKOS cels
 * and blast objects each have their own, and keeping them next to each other
 * is what keeps them from drifting. Returns the colour to write, given the
 * sprite's colour (after the actor palette) and the pixel already on screen.
 */
export interface ShadowRule {
  /** The actor's or object's shadow mode. */
  mode: number;
  table: Uint8Array;
  /** AKOS rendering, whose modes differ from a classic costume's. */
  akos: boolean;
  /**
   * Told when mode 3 names a table this build does not have.
   *
   * Mode 3 reads `table[colour * 256 + under]` for colours below 8, and a v6
   * game keeps only the one table (`readMAXS` allocates 256 bytes before v7).
   * Colour 0 lands in it and shades as usual; colours 1-7 land past its end,
   * where the reference reads whatever memory follows. There is no right answer
   * to reproduce there, so the pixel is drawn as it is and the caller told.
   */
  onPastTable?: (colour: number) => void;
}

/**
 * Shades one sprite pixel (`byleRLEDecode`'s shadow step, and
 * `bompApplyShadow1`/`bompApplyShadow3` for the BOMP-drawn codecs).
 *
 * - **Classic costume**: mode bit `0x20` shades every opaque pixel; otherwise
 *   colour 13 shades and anything else is painted.
 * - **AKOS mode 1**: colour 13 shades through the single table.
 * - **AKOS mode 3**: colours below 8 each pick a table — `table[colour * 256 +
 *   under]` — which is COMI's and The Dig's layered translucency. In a
 *   single-table build only colour 0's table exists; see `onPastTable`.
 *
 * Any other AKOS mode draws plainly: ScummVM's optimised decoder, the one it
 * ships, treats everything but 1 and 3 as mode 0 (`byleRLEDecodeFast`).
 *
 * `shaded` is set when the result came from the table, which the caller needs
 * for the reference's column skip.
 */
export function shadePixel(
  rule: ShadowRule,
  colour: number,
  under: number,
): { colour: number; shaded: boolean } {
  const { mode, table, akos } = rule;
  if (!akos) {
    if (mode & 0x20) return { colour: table[under], shaded: true };
    if (colour === SHADOW_COLOUR) return { colour: table[under], shaded: true };
    return { colour, shaded: false };
  }
  if (mode === 1 && colour === SHADOW_COLOUR) return { colour: table[under], shaded: true };
  if (mode === 3 && colour < 8) {
    const index = colour * TABLE_SIZE + under;
    if (index < table.length) return { colour: table[index], shaded: true };
    rule.onPastTable?.(colour);
  }
  return { colour, shaded: false };
}
