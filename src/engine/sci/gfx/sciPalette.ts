/**
 * SCI's two palettes: EGA's sixteen and VGA's two hundred and fifty-six.
 *
 * The same split AGI has and for the same reason, but SCI puts it on the
 * Version rather than on the platform: SCI0 and SCI1 EGA-only draw sixteen
 * colours, and from SCI1 on a game ships `palette` resources of its own.
 */

import type { Palette } from '../../gfx/Palette.js';

/**
 * The IBM EGA sixteen, as Sierra's interpreter drove them.
 *
 * The same sixteen AGI uses — this is the hardware's palette, not either
 * engine's — and they are written out rather than imported from AGI's copy,
 * because a shared constant between two Engine families is the coupling ADR
 * 0011 exists to avoid: the day one of them needs a variant, the other's
 * colours move.
 */
export const SCI_EGA_PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [0x00, 0x00, 0x00],
  [0x00, 0x00, 0xaa],
  [0x00, 0xaa, 0x00],
  [0x00, 0xaa, 0xaa],
  [0xaa, 0x00, 0x00],
  [0xaa, 0x00, 0xaa],
  [0xaa, 0x55, 0x00],
  [0xaa, 0xaa, 0xaa],
  [0x55, 0x55, 0x55],
  [0x55, 0x55, 0xff],
  [0x55, 0xff, 0x55],
  [0x55, 0xff, 0xff],
  [0xff, 0x55, 0x55],
  [0xff, 0x55, 0xff],
  [0xff, 0xff, 0x55],
  [0xff, 0xff, 0xff],
];

/**
 * Fills the low 256 entries with EGA's sixteen, dithered.
 *
 * SCI0 draws in sixteen colours but *stores* two per byte in the visual
 * buffer — a pixel is a pair of EGA indices that the display alternates
 * between, which is how Sierra got 136 apparent colours out of 16. So the
 * palette here is the 256 combinations, and the buffer holds the combination
 * rather than the colour.
 */
export function applyEgaPalette(palette: Palette): void {
  for (let index = 0; index < 256; index++) {
    const first = SCI_EGA_PALETTE[index & 0x0f];
    const second = SCI_EGA_PALETTE[(index >> 4) & 0x0f];
    // The average of the pair, which is what the alternation looks like at any
    // refresh rate a person can see. Sierra's own hardware alternated; a
    // browser cannot without flickering, and the average is the honest still.
    palette.setColor(
      index,
      (first[0] + second[0]) >> 1,
      (first[1] + second[1]) >> 1,
      (first[2] + second[2]) >> 1,
    );
  }
}

/** One entry of a SCI `palette` resource. */
export interface SciPaletteEntry {
  index: number;
  r: number;
  g: number;
  b: number;
  /**
   * Whether Sierra's own merge would copy this colour onto the screen palette.
   *
   * **A palette resource declares a range and marks most of it unused.** The
   * range is structure — where the entries live and how many bytes they take —
   * and `used` is the only thing that says which of them the resource is
   * actually about. `GfxPalette32::mergePalette` copies an entry only when it
   * is set, and SCI16's `GfxPalette::set` tests the same bit.
   *
   * Carried on the entry rather than applied in the reader, because the two
   * callers want opposite things: the screen wants Sierra's merge, and the
   * palette *editor* wants every entry a resource holds — 88% of the entries
   * King's Quest VII's Views declare are marked unused, and an editor that
   * hid them would be hiding most of the palette the game ships.
   *
   * **Absent means used**, which is right for every producer that is not a
   * palette resource: a vector Picture's own `setPalette` drawing operation and
   * a video's per-frame palette both name exactly the colours they set, and
   * neither format has a used flag to read.
   */
  used?: boolean;
}

/**
 * Reads a SCI1 or SCI1.1 `palette` resource.
 *
 * `base` is where the table starts, which is zero for a resource of its own and
 * non-zero for the copy a cel Picture carries inside itself. Giving the reader
 * an offset rather than a slice keeps a 57KB Picture from being copied to read
 * 256 colours out of the end of it.
 *
 * **SCI32's "hunk palette" is this table and not another one.** ScummVM holds
 * it in a class of its own, so this project expected a second reader and wrote
 * one — and then checked it against Torin, King's Quest VII, Lighthouse and
 * RAMA and got byte-identical answers from both, because the fields line up
 * exactly: the hunk header's palette count sits where this format's flag byte
 * does, and its entry header is this one's bytes 25 to 37. The second reader
 * was deleted. That is a small piece of evidence for ADR 0015's claim that
 * SCI's resource layout *drifts rather than breaks* — the palette did not
 * change at the SCI32 boundary at all.
 *
 * Two formats behind one resource type, told apart by the byte at offset 10:
 * zero for the SCI1.1 form and non-zero for SCI1's. Both carry a start index, a
 * colour count and a flag saying whether each entry is preceded by a "used"
 * byte — and reading three-byte entries as four-byte ones shifts every colour
 * after the first by one channel, which looks like a palette from a different
 * game rather than like a fault.
 */
export function readSciPalette(resource: Uint8Array, base = 0): SciPaletteEntry[] {
  if (resource.length < base + 37) return [];
  const u16 = (at: number): number => resource[at] | (resource[at + 1] << 8);

  const start = resource[base + 25];
  const count = u16(base + 29);
  const sharedUsed = resource[base + 32];
  const hasUsedByte = sharedUsed === 0;
  const at = base + 37;
  const stride = hasUsedByte ? 4 : 3;

  const entries: SciPaletteEntry[] = [];
  for (let i = 0; i < count; i++) {
    const base = at + i * stride;
    if (base + stride > resource.length) break;
    const offset = hasUsedByte ? base + 1 : base;
    entries.push({
      index: start + i,
      r: resource[offset],
      g: resource[offset + 1],
      b: resource[offset + 2],
      // `HunkPalette::toPalette`: with no shared value each entry carries its
      // own byte, and with one every entry in the range takes it.
      used: hasUsedByte ? resource[base] !== 0 : sharedUsed !== 0,
    });
  }
  return entries;
}

/**
 * Writes colours back into a palette resource, in place.
 *
 * **Patched, never re-laid out**, which is the same decision `writeSciView` and
 * `writeSciCursor` already make: the header, the start index, the count, the
 * used flags and every byte this project does not understand survive, because
 * the only bytes written are the three each entry was read from. An unedited
 * write is therefore byte-identical by construction rather than by care, and
 * `tests/sci-palette-edit.test.ts` holds that as the round trip.
 *
 * Entries are matched by their palette `index` — the number `readSciPalette`
 * reported — so a caller may pass back a subset, in any order, and colours it
 * did not name are left alone. An index this resource does not hold is skipped
 * rather than appended: a palette resource's range is part of its structure
 * and widening one here would move every byte after it.
 *
 * **Unused entries are writable and stay unused.** The used flag says whether
 * Sierra's own `set` submits the colour, not whether the colour is there, and
 * an editor that refused to touch one would be refusing to edit the palette a
 * game actually ships — 88% of the entries King's Quest VII's Views declare are
 * marked unused.
 */
export function writeSciPalette(
  resource: Uint8Array,
  entries: readonly SciPaletteEntry[],
  base = 0,
): Uint8Array {
  const out = new Uint8Array(resource);
  if (resource.length < base + 37) return out;

  const u16 = (at: number): number => resource[at] | (resource[at + 1] << 8);
  const start = resource[base + 25];
  const count = u16(base + 29);
  const hasUsedByte = resource[base + 32] === 0;
  const first = base + 37;
  const stride = hasUsedByte ? 4 : 3;

  const byIndex = new Map(entries.map((entry) => [entry.index, entry]));
  const clamp = (value: number): number => (value < 0 ? 0 : value > 255 ? 255 : value & 0xff);

  for (let i = 0; i < count; i++) {
    const entry = byIndex.get(start + i);
    if (!entry) continue;
    const at = first + i * stride + (hasUsedByte ? 1 : 0);
    if (at + 3 > out.length) break;
    out[at] = clamp(entry.r);
    out[at + 1] = clamp(entry.g);
    out[at + 2] = clamp(entry.b);
  }
  return out;
}

/**
 * Applies a palette resource's entries, as Sierra's merge applies them.
 *
 * **Only the entries the resource marks used**, which is
 * `GfxPalette32::mergePalette` and SCI16's `GfxPalette::set` alike. A palette
 * resource states a *range* — a start index and a count — and marks most of
 * that range unused with three zero bytes behind it, so submitting the whole
 * range paints black over every colour inside it that the resource was not
 * about.
 *
 * That is not a subtlety: King's Quest VII's first gameplay room composited
 * correctly and rendered as a black frame, because one View loaded into it
 * declares 72 through 255 and means 22 of them. Its 162 unused zeroes landed on
 * top of the three Pictures making up the room's scenery, which define 104
 * through 235.
 */
export function applySciPalette(palette: Palette, entries: readonly SciPaletteEntry[]): void {
  for (const entry of entries) {
    if (entry.index < 0 || entry.index > 255) continue;
    if (entry.used === false) continue;
    palette.setColor(entry.index, entry.r, entry.g, entry.b);
  }
}
