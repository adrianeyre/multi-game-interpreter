/**
 * Recognises Beneath a Steel Sky's data files.
 *
 * `loadEngine.ts` states the rule this follows: a family "answers on positive
 * evidence — a marker file this family owns — never on the absence of another
 * family's, because 'not SCUMM' is not evidence of anything".
 *
 * **Both halves, never either alone.** The SCI entry already carries this rule
 * and gives the reason: a lone marker from half an extracted archive is not
 * evidence of a game, and claiming it takes SCUMM's good failure message away
 * from a dump that has one. Sky's two halves are the data file and the index
 * that addresses it.
 *
 * What this deliberately does **not** look for is the game's executable. A dump
 * without it cannot boot — ADR 0024 reads the Compacts from there and there is
 * no world without them — but that is a refusal Sky should make *itself*, in a
 * message naming the missing file. Detecting on it would hand such a dump to
 * SCUMM's catch-all, which would report something unhelpful and true about
 * indexes instead of the one thing the player needs to hear.
 */

/** Lowercased final path segment, matching `engineSignatures.ts`'s `baseName`. */
function baseName(name: string): string {
  return (name.replace(/\\/g, '/').split('/').pop() ?? name).toLowerCase();
}

/** The data file and the index that addresses it. Both, or it is not a claim. */
const SKY_MARKERS = ['sky.dsk', 'sky.dnr'] as const;

export function looksLikeSky(fileNames: string[]): boolean {
  const present = new Set(fileNames.map(baseName));
  return SKY_MARKERS.every((name) => present.has(name));
}
