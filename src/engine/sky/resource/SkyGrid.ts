/**
 * Sky's walk grids: the per-screen map of where a mega may stand.
 *
 * ## What this establishes, and what it does not
 *
 * The prior state of this engine reported, on every section entry, that the
 * walk grid was one of three things a room needs "none of which exists here".
 * For the grid that is false. The grids ship in the resource file, at a run of
 * seventy resources starting at {@link GRID_FILE_START}, each exactly
 * {@link GRID_SIZE} bytes — matching ScummVM's `TOT_NO_GRIDS` and `GRID_SIZE`
 * exactly. This module reads them and checks that shape against the shipped
 * bytes, which is the one thing here that a person can check without a running
 * game: the container's extent and its uniform record size (the coverage check
 * ADR 0024/0033 call for).
 *
 * Two layers above this are **not** established here, and the report says so:
 *
 *  - **The screen→grid map.** ScummVM does not use grid `n` for screen `n`; it
 *    passes the screen through `Grid::_gridConvertTable`, a lookup array that
 *    lives in its *source*. ADR 0033 asks that a directory living only in a
 *    reimplementation be derived from shipped bytes or refused by name. It was
 *    looked for and does not derive, so it is refused. The routes tried, and
 *    what each measured:
 *      - the Compact table: no record's words address a grid resource — zero
 *        hits across the 3258 records for the range 60000..60069 — and no
 *        `getToTable` (which carries target/script-offset pairs) or `mainList`
 *        (which carries logic ids) holds a grid slot. The map is not
 *        game-authored data. The sweep prints this count so it stays checked.
 *      - position: seventy grids against far more screens (a section's logic
 *        list runs past six hundred ids), so screen `n` → grid `n` cannot hold,
 *        and the container offers no other positional rule.
 *      - the disk index (`sky.dnr`): keys resources by id alone, with no screen
 *        association a slot could be read from.
 *      - an executable-resident table (ADR 0024): the freeware CD and floppy
 *        ship no executable at all — only `sky.dnr`/`sky.dsk`(/`sky.cpt`) — so
 *        there is nothing to read one out of. (The demo ships `SKY.EXE`, but it
 *        is a different Release covering only a slice of screens.)
 *      - **the set of screens a Compact stands on**, ranked. This is the
 *        closest anything has come and it still does not close. The reference's
 *        table is a dense numbering — a screen that has a grid takes the next
 *        index — so the map would derive from nothing but the *set* of screens
 *        that have one. Reading `screen` off all 3,258 records gives 74
 *        distinct screens below 150, and seventy grids ship: the Compacts name
 *        the grid-bearing screens **and four others**, 66, 80, 101 and 102.
 *        Nothing in the container separates those four from the seventy — they
 *        carry Compacts like any location, eight to nineteen each — so the rule
 *        would need a fifth fact this reader does not have. Counting the extras
 *        took comparing against the reference's table, which is what the
 *        reference is for; picking the four out by that comparison and writing
 *        them down is the transcription clause 1 refuses, so it is not done
 *        here. What it does establish is where the remaining gap is: not the
 *        ordering, which derives, but the membership of four screens.
 *    Fitting the seventy grids to `_gridConvertTable`'s values would be
 *    transcribing it by another name, which is why none of the above does that.
 *    What would settle it: the targeted Release shipping the map in a
 *    game-authored resource or an executable. Until then "the grid for this
 *    screen" cannot be named, only "the seventy grids" as a set.
 *
 *  - **The router.** Nothing walks on these bits, and that follows from the
 *    refusal above rather than from missing work. `fnAr` now lands and megas
 *    walk — see `SkyWorld.routeDirection` — but a router with no way to name
 *    the grid for the screen it is on has nothing to ask "is this cell
 *    blocked", so the route it builds is a straight line and the module doc
 *    there says so. The bit test below therefore still has no consumer in
 *    gameplay and its per-pixel result is *unverified against a running game*.
 *    What the test suite does check is the one property that holds without a
 *    game: the bit-index maths is a bijection onto the grid's 960 bits, i.e. it
 *    addresses every cell once and none twice.
 *
 * Constants and the bit layout are transcribed from ScummVM's `skydefs.h` and
 * `Grid::getGridValues`, the same provenance as `skyMcodes.ts`.
 */

import type { SkyResources } from './SkyResources.js';

/** The first grid resource; grids run for {@link TOT_NO_GRIDS} ids from here. */
export const GRID_FILE_START = 60000;
/** How many grids a release ships. ScummVM `TOT_NO_GRIDS`. */
export const TOT_NO_GRIDS = 70;
/** Each grid's size in bytes. ScummVM `GRID_SIZE`. */
export const GRID_SIZE = 120;

/** The playfield, in pixels. ScummVM `GAME_SCREEN_WIDTH`/`_HEIGHT`. */
const GAME_SCREEN_WIDTH = 320;
const GAME_SCREEN_HEIGHT = 192;
/** The grid's origin on screen, in pixels. ScummVM `TOP_LEFT_X`/`_Y`. */
const TOP_LEFT_X = 128;
const TOP_LEFT_Y = 136;

/**
 * A grid cell is eight pixels square (`x >>= 3`, `y >>= 3` in getGridValues),
 * so the grid is forty cells wide and twenty-four tall. That the two derive the
 * record size — 40 × 24 = 960 bits = 120 bytes — is not a coincidence to state
 * in prose and leave unchecked: {@link SkyGrids.verify} asserts it against the
 * bytes the file actually carries.
 */
export const GRID_COLS = GAME_SCREEN_WIDTH >> 3; // 40
export const GRID_ROWS = GAME_SCREEN_HEIGHT >> 3; // 24
/** ScummVM's per-row bit stride, stated in getGridValues as `y * 40`. */
export const GRID_ROW_STRIDE = 40;

/** What {@link SkyGrids.verify} found about the shipped grid resources. */
export interface SkyGridVerdict {
  /** How many of the {@link TOT_NO_GRIDS} expected ids are present. */
  present: number;
  /** The distinct byte-lengths seen, so a wrong one shows rather than hides. */
  sizes: number[];
  /** All {@link TOT_NO_GRIDS} present and each exactly {@link GRID_SIZE} bytes. */
  complete: boolean;
}

export class SkyGridError extends Error {}

/**
 * The walk grids for one game, read from its resources.
 *
 * Reads every present grid in `[GRID_FILE_START, GRID_FILE_START +
 * TOT_NO_GRIDS)`. Absence is tolerated rather than thrown — a release without
 * grids is reported by {@link verify}, not a crash at boot — because nothing
 * routes on them yet, so a missing grid costs a truthful line, not a broken
 * game.
 */
export class SkyGrids {
  private constructor(private readonly grids: ReadonlyMap<number, Uint8Array>) {}

  /** Reads the grids a resource file carries, keeping each by its screen slot. */
  static load(resources: SkyResources): SkyGrids {
    const grids = new Map<number, Uint8Array>();
    for (let slot = 0; slot < TOT_NO_GRIDS; slot += 1) {
      const id = GRID_FILE_START + slot;
      if (!resources.entry(id)) continue;
      grids.set(slot, resources.read(id));
    }
    return new SkyGrids(grids);
  }

  /** How many grid slots were found. */
  get count(): number {
    return this.grids.size;
  }

  /**
   * The structural check against the shipped bytes: seventy grids, each of the
   * one size. This is the claim that is a claim — the extent and record size a
   * person can confirm from the file without a running game.
   */
  verify(): SkyGridVerdict {
    const sizes = new Set<number>();
    for (const grid of this.grids.values()) sizes.add(grid.length);
    const complete = this.grids.size === TOT_NO_GRIDS && sizes.size === 1 && sizes.has(GRID_SIZE);
    return { present: this.grids.size, sizes: [...sizes].sort((a, b) => a - b), complete };
  }

  /** The raw bytes of one grid slot, or null when that slot is absent. */
  bytes(slot: number): Uint8Array | null {
    return this.grids.get(slot) ?? null;
  }

  /**
   * The bit index in a grid for a screen pixel, or null when off the grid.
   *
   * The maths is ScummVM's `getGridValues`: cell `(x>>3, y>>3)` after removing
   * the top-left origin, a row stride of forty, and — the one non-obvious part
   * — a reversal of the low five bits *within each thirty-two-bit dword*, so
   * bit `b` of a dword is stored at bit `31 - b`. That reversal is why a naive
   * reader gets a mirror-image of every room's walkable area.
   *
   * Exported for the test that proves it a bijection onto `[0, 960)`.
   */
  static bitIndex(screenX: number, screenY: number): number | null {
    const col = (screenX - TOP_LEFT_X) >> 3;
    const row = (screenY - TOP_LEFT_Y) >> 3;
    if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) return null;
    let bit = row * GRID_ROW_STRIDE + col;
    // Reverse the low five bits inside the dword the bit falls in.
    const withinDword = 0x1f - (bit & 0x1f);
    bit = (bit & ~0x1f) + withinDword;
    return bit;
  }

  /**
   * Whether a screen pixel is plotted blocked in a grid slot.
   *
   * **Unverified against gameplay** — see the module note. A `true`/`false`
   * here reads a real bit of a real shipped grid, but until the router walks on
   * it nothing confirms that bit means what this reader says it does.
   */
  blockedAt(slot: number, screenX: number, screenY: number): boolean {
    const grid = this.grids.get(slot);
    if (!grid) throw new SkyGridError(`grid slot ${slot} is not loaded`);
    const bit = SkyGrids.bitIndex(screenX, screenY);
    if (bit === null) return false;
    return (grid[bit >> 3] & (1 << (bit & 7))) !== 0;
  }
}
