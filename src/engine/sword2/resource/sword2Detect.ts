/**
 * Recognises Broken Sword II: The Smoking Mirror's data files.
 *
 * The rule every family here follows: positive evidence this family owns, both
 * halves, never either alone. Sword2's halves are its **two index files** —
 * `resource.inf` names the clusters and `resource.tab` maps resource ids into
 * them — and neither is any use without the other.
 *
 * ## Why this is not Sword1's detector with a different string
 *
 * `engineSignatures.ts` matched Broken Sword II on `general.clu` alone, which
 * is a name both games ship. That is the mis-detection this file exists to
 * prevent, and it is the reason the evidence here is the *index* rather than a
 * cluster: Sword1's index is `swordres.rif` and Sword2's is a pair of plain
 * files with no magic number at all, so a folder holding both games' clusters
 * (people do this) is told apart by which index it has.
 *
 * The two are separate Engine families and share nothing (ADR 0036): Sword1's
 * RIF is a nested cluster/group/resource tree, and Sword2's `resource.tab` is a
 * flat array of `(cluster, index)` pairs with the per-cluster index at the *end*
 * of each cluster file. Same publisher, same word in the title, no shared byte.
 */

/** Lowercased final path segment, matching `engineSignatures.ts`'s `baseName`. */
function baseName(name: string): string {
  return (name.replace(/\\/g, '/').split('/').pop() ?? name).toLowerCase();
}

/** Both index files, or it is not a claim. */
const SWORD2_MARKERS = ['resource.inf', 'resource.tab'] as const;

export function looksLikeSword2(fileNames: string[]): boolean {
  const present = new Set(fileNames.map(baseName));
  return SWORD2_MARKERS.every((name) => present.has(name));
}

/**
 * One packaging of Broken Sword II. `CONTEXT.md` calls this a **Release**.
 *
 * - `demo` — the single-CD demo.
 * - `cd` — the retail game, two discs.
 * - `psx` — the PlayStation conversion, which ships no `cd.inf` and keeps its
 *   backgrounds in a `screens.clu` this project does not read.
 */
export type Sword2Release = 'demo' | 'cd' | 'psx';

export const SWORD2_RELEASES: readonly Sword2Release[] = ['demo', 'cd', 'psx'];

/** How a Release was established, carried with the Target like every family's. */
export type Sword2Identification =
  /** A file only one Release ships. */
  | 'shipped-files'
  /** The index's own shape said so. */
  | 'index-structure'
  /** Nothing identified it; `cd` was assumed, which plays and does not edit. */
  | 'fallback';

export interface Sword2Detection {
  readonly release: Sword2Release;
  readonly identification: Sword2Identification;
  readonly evidence: string;
}

/**
 * Works out which Release a folder holds.
 *
 * The PlayStation conversion is named by the *absence* of `cd.inf` together
 * with the presence of `screens.clu`, which is a pair rather than an absence:
 * ScummVM's own PSX path is "we have only one disk in the PSX version" and
 * skips `cd.inf` entirely, and `screens.clu` exists in no PC release.
 */
export function identifySword2(fileNames: string[]): Sword2Detection {
  const present = new Set(fileNames.map(baseName));
  const has = (name: string): boolean => present.has(name);

  if (has('screens.clu') && !has('cd.inf')) {
    return {
      release: 'psx',
      identification: 'shipped-files',
      evidence: 'screens.clu with no cd.inf, which is the PlayStation packaging',
    };
  }

  // The demo's own closing sequence. `function.cpp:2131` special-cases the
  // sequence name "enddemo" for this Release, so the file is the demo's in
  // Revolution's own numbering and not merely a file the retail release omits.
  // The zip of the demo renames `demo.smk` to `demo.smdk`, hence the pattern.
  const endDemo = present.has('enddemo.smk') || present.has('enddemo.dxa');
  const demoIntro = [...present].some((name) => /^demo\.(smk|smdk|dxa)$/.test(name));
  if (endDemo || demoIntro) {
    return {
      release: 'demo',
      identification: 'shipped-files',
      evidence: endDemo
        ? 'enddemo.smk, which is the demo’s own closing sequence'
        : 'a demo.smk sequence, which only the demo plays',
    };
  }

  // The retail game ships two speech and two music clusters, one per disc; the
  // demo ships none at all.
  if (has('speech2.clu') || has('music2.clu')) {
    return {
      release: 'cd',
      identification: 'shipped-files',
      evidence: 'a second speech or music cluster, which only the two-disc release ships',
    };
  }

  // `docks.clu` used to be read here as "a region cluster no demo ships", and
  // the mounted demo ships exactly that cluster — the demo *is* the docks
  // section. So the clause said retail about every demo folder, and because it
  // claimed `shipped-files` the refinement below returned early and never
  // corrected it. It is gone rather than narrowed: `refineSword2Release` reads
  // the index, which is strictly better evidence and is always available.

  return {
    release: 'cd',
    identification: 'fallback',
    evidence: 'no file distinguished the Release; the retail packaging was assumed',
  };
}

/**
 * Narrows a Release once `resource.inf` has actually been read.
 *
 * A second pass rather than a cleverer first one, because the cluster list is
 * only knowable after `resource.inf` is parsed and detection has to answer
 * before any file is read past its name.
 *
 * **The test is that the index names no speech and no music cluster**, and that
 * is deliberately a statement about the *index* rather than about the folder.
 * `resource.inf` ships complete: it enumerates every cluster the release has,
 * and `resource.tab` addresses speech and music resources into them, so a
 * retail `resource.inf` names them whether or not the 176 MB file was copied.
 * You cannot make a retail install look like a demo by deleting files — only by
 * editing the index — which is the property `sword2Detect.ts`'s own header asks
 * for and which a cluster *count* did not have.
 *
 * That count is what this used to test, at `< 12`. Measured against the mounted
 * demo it was wrong on its own terms: that folder's `resource.inf` lists
 * **fourteen** clusters, because a demo's index still names the region clusters
 * of the full game it was cut from.
 *
 * This now overrides a file-name reading rather than deferring to one, because
 * index structure is the stronger evidence of the two. `psx` is left alone: it
 * is a conversion rather than a cut, and its Release is settled by `cd.inf`.
 */
export function refineSword2Release(
  detection: Sword2Detection,
  clusterNames: readonly string[],
): Sword2Detection {
  if (detection.release === 'psx') return detection;
  if (clusterNames.length === 0) return detection;

  const spoken = clusterNames.filter((name) => /^(speech|music)\d*\.clu$/i.test(name));
  if (spoken.length === 0) {
    return {
      release: 'demo',
      identification: 'index-structure',
      evidence:
        `resource.inf names ${clusterNames.length} clusters and not one of them is a speech ` +
        `or music cluster, which no retail index omits`,
    };
  }
  if (detection.identification !== 'shipped-files') {
    return {
      release: 'cd',
      identification: 'index-structure',
      evidence: `resource.inf names ${spoken.join(' and ')}, which only the retail release has`,
    };
  }
  return detection;
}
