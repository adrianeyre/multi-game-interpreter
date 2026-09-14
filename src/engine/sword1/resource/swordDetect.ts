/**
 * Recognises Broken Sword: The Shadow of the Templars' data files.
 *
 * The rule `skyDetect.ts` states and `lureDetect.ts` follows: positive evidence
 * this family owns, **both halves, never either alone**. Sword's two halves are
 * the cluster index and at least one cluster it names.
 *
 * `engineSignatures.ts` has matched Broken Sword on `swordres.rif` alone since
 * before this family was in scope, as a *foreign* engine. Requiring a cluster
 * beside it brings the claim under the rule every other family follows: a lone
 * `swordres.rif` from a half-finished extraction is not evidence of a game, and
 * claiming it takes SCUMM's good failure messages away from a dump that has one.
 *
 * ## What this deliberately does not look for
 *
 * **The executable.** Broken Sword needs no support file — its index is
 * self-describing (`rif.ts`) — so unlike AGOS and the Virtual Theatre families
 * there is nothing to read out of a binary and nothing to refuse for its
 * absence.
 *
 * **Speech, music and video.** A CD1-only install has no `SPEECH2.CLU` and no
 * `SYRIA.CLU`, and it is a real thing people have. Refusing it here would hand
 * it to SCUMM's catch-all, which would say something true and unhelpful about
 * index files; `SwordResources` refuses by *name* instead, and only for the
 * three clusters the game genuinely cannot start without.
 */

/** Lowercased final path segment, matching `engineSignatures.ts`'s `baseName`. */
function baseName(name: string): string {
  return (name.replace(/\\/g, '/').split('/').pop() ?? name).toLowerCase();
}

/** `.CLU` on every PC release, `.CLM` on the Macintosh one. */
const CLUSTER = /\.(clu|clm)$/;

export function looksLikeSword1(fileNames: string[]): boolean {
  const present = fileNames.map(baseName);
  if (!present.includes('swordres.rif')) return false;
  return present.some((name) => CLUSTER.test(name));
}

/**
 * One packaging of Broken Sword. `CONTEXT.md` calls this a **Release**.
 *
 * Three, and the axis is a Release rather than a Version for the reason ADR
 * 0023 gives about Sky: there is one game and one engine lineage under it. What
 * varies is what shipped.
 *
 * - `demo` — the single-CD demo, which ships `PARIS1` and nothing after it.
 * - `cd` — the retail game, two discs.
 * - `psx` — the PlayStation conversion, whose graphics are HIF-compressed and
 *   tiled. Named here because it is *identifiable*; whether it draws is
 *   `SwordScreen`'s answer, not this module's.
 */
export type Sword1Release = 'demo' | 'cd' | 'psx';

export const SWORD1_RELEASES: readonly Sword1Release[] = ['demo', 'cd', 'psx'];

/**
 * How a Release was established. Carried with the Target, like every other
 * family's identification, so a later reader is not guessing at what guessed.
 */
export type Sword1Identification =
  /** A file only one Release ships — `speech.inf`, a second speech cluster. */
  | 'shipped-files'
  /** The index's own shape said so. */
  | 'index-structure'
  /** Nothing identified it; `cd` was assumed, which plays and does not edit. */
  | 'fallback';

/**
 * The machine a Release was packaged for, when its files say.
 *
 * Kept apart from {@link Sword1Release} because the two are different axes and
 * were being conflated in one hardcoded word: `SwordEngine.targetName` read
 * `Sword1 (${release} release, DOS)`, so the Macintosh demo announced itself as
 * DOS and the PlayStation one as "psx release, DOS", which contradicts itself.
 *
 * `unknown` is a real answer and the default. This module's header argues that
 * a Release is named on **positive evidence**, never on another's absence, and
 * a platform is the same: a folder with none of the markers below is not
 * thereby DOS.
 */
export type Sword1Platform = 'dos' | 'macintosh' | 'playstation' | 'unknown';

export interface Sword1Detection {
  readonly release: Sword1Release;
  /** What the files say it was packaged for, or `unknown` when they do not. */
  readonly platform: Sword1Platform;
  readonly identification: Sword1Identification;
  /** What the evidence was, for the log and for the editor's refusal message. */
  readonly evidence: string;
}

/**
 * Works out which Release a folder holds.
 *
 * Positive evidence in every branch, including the demo's — which was not true
 * until this run. The PSX conversion is named by its `speech.inf`: ScummVM's own
 * detection entries for it key on `english/speech.inf`, a file no PC release
 * ships.
 *
 * The demo used to be named by "paris1.clu with no later region cluster beside
 * it", which is the absence argument this module's own header argues against —
 * and it is wrong about a real install, because a retail CD1-only copy has
 * `PARIS1` and nothing after it too. The demo has two files of its own instead:
 *
 * - **`cows.mad`**, its speech file. ScummVM opens that name and nothing else
 *   sets `_cowMode = CowDemo` (`sound.cpp:784`), so the file *is* the demo's
 *   speech packaging rather than a retail file left out.
 * - **`enddemo.smk`**, its closing sequence — entry 18 of ScummVM's own
 *   sequence list, commented "for end of single CD demo" (`animation.cpp:71`).
 *
 * Either alone is a claim, and the pair is the "both halves" this file asks for
 * elsewhere; `1m14a.wav` is a third, which ScummVM's PC file list is the only
 * entry to flag `FLAG_DEMO` on its own, and it is accepted as a half because a
 * demo install without its music folder is a real thing.
 */
/**
 * What the files say this packaging was built for.
 *
 * Positive evidence only, in the same spirit as the Release branches below:
 *
 * - **Macintosh** — `ppc.inf` and a `PPC` folder beside the clusters. The
 *   PowerPC build keeps its executable there, and no PC release ships either.
 * - **PlayStation** — `speech.inf`, which is already the evidence the `psx`
 *   Release is named by, so the two agree by construction rather than by
 *   coincidence.
 * - **DOS** — `dos4gw.exe`, the DOS extender Revolution shipped the PC build
 *   with, or `sword.exe` itself.
 *
 * Anything else is `unknown`, which is the honest answer for a folder holding
 * only clusters — a dump of the data with the installer files thrown away is
 * not evidence of a platform, and saying DOS about it is the bug this replaces.
 */
function identifySword1Platform(present: string[]): Sword1Platform {
  const has = (name: string): boolean => present.includes(name);
  if (has('ppc.inf') || has('ppc')) return 'macintosh';
  if (has('speech.inf')) return 'playstation';
  if (has('dos4gw.exe') || has('sword.exe')) return 'dos';
  return 'unknown';
}

export function identifySword1(fileNames: string[]): Sword1Detection {
  const present = fileNames.map(baseName);
  const has = (name: string): boolean => present.includes(name);
  const platform = identifySword1Platform(present);

  if (present.some((name) => /^speech\.inf$/.test(name))) {
    return {
      release: 'psx',
      platform,
      identification: 'shipped-files',
      evidence: 'speech.inf, which only the PlayStation conversion ships',
    };
  }

  // The retail game is two discs and ships eight region clusters; the demo
  // ships PARIS1 and stops. `SYRIA.CLU` is on disc two, so its absence alone
  // does not mean "demo" — `PARIS2` is on disc one and a retail CD1 install has
  // it, while no demo does.
  if (has('paris2.clu') || has('paris2.clm')) {
    return {
      release: 'cd',
      platform,
      identification: 'shipped-files',
      evidence: 'paris2.clu, a region cluster no demo ships',
    };
  }
  if (has('speech2.clu') || has('speech1.clu')) {
    return {
      release: 'cd',
      platform,
      identification: 'shipped-files',
      evidence: 'a numbered speech cluster, which only the retail release ships',
    };
  }

  // The demo's own files, named above. Two halves, so a folder that has lost
  // one of the three still identifies.
  const demoMarkers = [
    has('cows.mad') ? 'cows.mad, which is the demo’s own speech packaging' : null,
    has('enddemo.smk') || has('enddemo.dxa') ? 'enddemo.smk, the demo’s closing sequence' : null,
    has('1m14a.wav') ? '1m14a.wav, a music cue only the demo uses' : null,
  ].filter((evidence): evidence is string => evidence !== null);
  if (demoMarkers.length >= 2) {
    return {
      release: 'demo',
      platform,
      identification: 'shipped-files',
      evidence: demoMarkers.join(' and '),
    };
  }
  if (demoMarkers.length === 1) {
    return {
      release: 'demo',
      platform,
      identification: 'shipped-files',
      evidence:
        `${demoMarkers[0]} — one half rather than two, so the rest of this install ` +
        `said nothing either way`,
    };
  }

  return {
    release: 'cd',
    platform,
    identification: 'fallback',
    evidence: 'no file distinguished the Release; the retail packaging was assumed',
  };
}

/**
 * What each platform is called in a Target, and `unknown` called nothing.
 *
 * An empty string rather than the word "unknown": a Target that reads
 * `Sword1 (cd release, unknown)` tells a reader less than one that reads
 * `Sword1 (cd release)` and looks like a failure rather than an abstention.
 */
export const SWORD1_PLATFORM_NAMES: Readonly<Record<Sword1Platform, string>> = {
  dos: 'DOS',
  macintosh: 'Macintosh',
  playstation: 'PlayStation',
  unknown: '',
};
