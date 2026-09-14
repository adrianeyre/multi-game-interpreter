/**
 * Recognises Lure of the Temptress's data files.
 *
 * The same rule `skyDetect.ts` follows and for the same reasons — positive
 * evidence this family owns, and both halves rather than either alone.
 *
 * Lure is a **separate family** from Sky (ADR 0026), not a Sky Release, so this
 * is a separate detector rather than a branch inside one. The two games share a
 * publisher and an engine *name*; they share no resource layout, which is one
 * of the two `CONTEXT.md` tests Virtual Theatre fails.
 *
 * **`lure.dat` is deliberately not evidence.** It is ScummVM's generated
 * support file, not something Revolution shipped, and ADR 0024 refuses to read
 * it. Detecting on it would claim a folder that has ScummVM's artefact and
 * might not have the game.
 *
 * The both-halves evidence is `disk1.vga` plus at least one further numbered
 * disk file. `engineSignatures.ts` has matched Lure on `disk1.vga` alone since
 * before this family was in scope; requiring a second brings it under the rule
 * every other family follows. Whether every Release ships more than one is
 * confirmed by the resource-layer work rather than assumed here — if a Release
 * turns out to ship exactly one, this predicate is what needs revisiting, and
 * failing to claim is the safe direction to be wrong in.
 */

/** Lowercased final path segment, matching `engineSignatures.ts`'s `baseName`. */
function baseName(name: string): string {
  return (name.replace(/\\/g, '/').split('/').pop() ?? name).toLowerCase();
}

const NUMBERED_DISK = /^disk(\d+)\.vga$/;

export function looksLikeLure(fileNames: string[]): boolean {
  const present = new Set(fileNames.map(baseName));
  if (!present.has('disk1.vga')) return false;
  for (const name of present) {
    const match = NUMBERED_DISK.exec(name);
    if (match && match[1] !== '1') return true;
  }
  return false;
}
