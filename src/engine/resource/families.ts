/**
 * The Engine families this project implements, named in one place.
 *
 * Two things read this list and both used to hardcode their own answer.
 * `engineSignatures.ts` told every player "This project implements SCUMM only",
 * which stopped being true when AGI landed at #125 and was false three times
 * over by the time anybody noticed. A sentence that has to be remembered is a
 * sentence that goes stale, so the sentence is generated instead.
 *
 * Adding a family means adding it here and nowhere else in the messaging path.
 * A family belongs on this list when it has an interpreter — the same bar that
 * decides whether it is still in `SIGNATURES` as a *foreign* engine, so the two
 * cannot disagree.
 */
/**
 * In the order they landed.
 *
 * **AGOS was missing here for its whole first release**, which is the same rot
 * this file was written to prevent, one family later: it left `SIGNATURES` as a
 * foreign engine when it gained an interpreter (ADRs 0027-0030) and nobody
 * added it to the list that names what this project implements, so every
 * refusal message told a player about three families out of four. Found by
 * `npm run play:vt`, which prints the refusal for a game that does not run yet
 * and therefore reads the sentence out loud on every run.
 *
 * A family with an interpreter that does not draw still belongs here. AGOS is
 * that case — it reads, identifies, decompiles and saves — and what it cannot
 * do is a question its own status line answers, not one this list should be
 * hiding behind an omission.
 */
export const IMPLEMENTED_FAMILIES: readonly string[] = [
  'SCUMM',
  'AGI',
  'SCI',
  'AGOS',
  'Sky',
  'Lure',
  'Sword1',
  'Sword2',
];

/** "SCUMM, AGI, SCI, AGOS, Sky, Lure, Sword1 and Sword2" — Oxford-free. */
export function describeImplementedFamilies(
  families: readonly string[] = IMPLEMENTED_FAMILIES,
): string {
  if (families.length === 0) return 'nothing yet';
  if (families.length === 1) return families[0];
  return `${families.slice(0, -1).join(', ')} and ${families[families.length - 1]}`;
}
