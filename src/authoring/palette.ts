/**
 * The default 256 colour palette for authored games.
 *
 * Laid out so the useful colours have memorable low indices: 0 is transparent
 * black, 1-15 are an EGA-like set that matches what the verb and text defaults
 * expect, and the rest is a 6x6x6 colour cube followed by a grey ramp.
 */
export function defaultPalette(): number[][] {
  const palette: number[][] = [];

  const base: number[][] = [
    [0, 0, 0], // 0 black (transparent in costumes)
    [0, 0, 170], // 1 blue
    [0, 170, 0], // 2 green
    [0, 170, 170], // 3 cyan
    [170, 0, 0], // 4 red
    [170, 0, 170], // 5 magenta
    [170, 85, 0], // 6 brown
    [170, 170, 170], // 7 light grey
    [85, 85, 85], // 8 dark grey
    [85, 85, 255], // 9 bright blue
    [85, 255, 85], // 10 bright green
    [85, 255, 255], // 11 bright cyan
    [255, 85, 85], // 12 bright red
    [255, 85, 255], // 13 bright magenta
    [255, 255, 85], // 14 yellow
    [255, 255, 255], // 15 white
  ];
  palette.push(...base);

  // 16-231: a 6x6x6 cube, the standard trick for covering the space evenly.
  const levels = [0, 51, 102, 153, 204, 255];
  for (const r of levels) {
    for (const g of levels) {
      for (const b of levels) {
        palette.push([r, g, b]);
      }
    }
  }

  // The remainder: a grey ramp, useful for shading and dithering.
  while (palette.length < 256) {
    const step = palette.length - 232;
    const value = Math.round((step / 23) * 255);
    palette.push([value, value, value]);
  }

  return palette.slice(0, 256);
}

/** Nearest palette index for an RGB triple, by squared distance. */
export function nearestColor(palette: number[][], r: number, g: number, b: number): number {
  let best = 0;
  let bestDistance = Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < palette.length; i++) {
    const [pr, pg, pb] = palette[i];
    const distance = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/**
 * Converts a SCUMM colour table into editor palette entries.
 *
 * VGA hardware took six bits per channel, so a room's table usually holds
 * values up to 63 and has to be scaled to fill a byte — the same normalisation
 * the engine applies before drawing. A table that already uses the full range
 * is left alone, because a release that stores eight-bit colour would otherwise
 * come out four times too bright.
 */
export function paletteFromClut(clut: Uint8Array): number[][] {
  const count = Math.min(256, Math.floor(clut.length / 3));

  let max = 0;
  for (let i = 0; i < count * 3; i++) if (clut[i] > max) max = clut[i];
  const scale = max > 0 && max <= 63 ? 255 / 63 : 1;

  const palette: number[][] = [];
  for (let i = 0; i < count; i++) {
    palette.push([
      Math.round(clut[i * 3] * scale),
      Math.round(clut[i * 3 + 1] * scale),
      Math.round(clut[i * 3 + 2] * scale),
    ]);
  }
  while (palette.length < 256) palette.push([0, 0, 0]);
  return palette;
}

/**
 * The palette indices an editor should offer for a room.
 *
 * Sixteen entries for a sixteen-colour release and a spread across 256 for
 * everything else. Offering 256 on a v2, v3 or EGA v4 room is not a cosmetic
 * surplus: the encoder writes a colour index into four bits, so a colour picked
 * above fifteen is written back as a *different* colour — silently, and only in
 * the exported game, which is the worst place to find out.
 *
 * The spread rather than all 256, above sixteen, because a picker with 256
 * swatches is a picker nobody uses: the first sixteen are the named colours a
 * game's own text and verbs are drawn in, and the rest samples the cube.
 */
export function paletteChoices(colours: number): number[] {
  if (colours <= 16) return Array.from({ length: Math.max(1, colours) }, (_, i) => i);
  return [
    ...Array.from({ length: 16 }, (_, i) => i),
    ...Array.from({ length: 32 }, (_, i) => 16 + i * 7),
  ];
}
