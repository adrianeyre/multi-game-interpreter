/**
 * Which Kernel calls this engine answers, at every Version, measured from the
 * code rather than from a grep.
 *
 * **Why this is a module and not a one-off.** The count this replaces was taken
 * by matching handler keys against table names with `awk` and `comm`, and it was
 * wrong four ways: it counted a placeholder slot as a call, it read SCI16 as one
 * table when SCI0 ships a different one, it put calls Sierra never implemented
 * in with calls this project has not written yet, and it missed that SCI1 late
 * and SCI1.1 renumber slots and so have gaps of their own. A
 * count taken outside the code decays the moment the code moves;
 * `docs/processes/verifying-version-support.md` calls the standing version of
 * such a check the thing that keeps a claim from rotting, and this is SCI's.
 *
 * **Four columns, not two.** "Implemented", "answers a constant", "answered by
 * the unused-call stub" and "missing" are four different facts, and merging any
 * of the first three claims behaviour for calls nothing is written behind.
 *
 * The middle two are both "a handler exists and does nothing", split because
 * they are different kinds of nothing. `SCI_UNUSED_KERNEL_NAMES` is the set
 * Sierra shipped and no retail game calls, answered by a stub that logs. The
 * larger `SCI_CONSTANT_KERNEL_NAMES` is calls games make constantly — `DoSound`,
 * `Parse`, `SaveGame` — whose handler returns the same value whatever it is
 * passed. Both lists live in `SciKernel.ts` with their reasoning.
 *
 * **This column is the fifth way the original count was wrong, and the largest.**
 * The first four were artefacts of measuring with `awk` outside the code; this
 * one survived being measured inside it, because the code was asked whether a
 * *key* existed rather than whether a behaviour did. Under the old reading,
 * closing SCI1's whole gap needed six lines of `() => NULL_REG`.
 *
 * **What it cannot measure.** `SciEngine.kernelNameFor` prefers the table a
 * game ships in its own `vocab.999` over the one built here, and below SCI1
 * most games ship one. So this measures the tables this project carries, which
 * is a claim about this repository rather than about any game — Tier 1 in the
 * sense `verifying-version-support.md` means, and it says so rather than
 * letting a reader take it for more.
 */

import { SCI_VERSIONS, type SciVersion } from '../sciVersion.js';
import { kernelNamesFor, kernelTableSize } from './kernel.js';
import { SCI_CONSTANT_KERNEL_NAMES, SCI_KERNEL, SCI_UNUSED_KERNEL_NAMES } from './SciKernel.js';

/**
 * A slot Sierra shipped as a placeholder rather than as a call.
 *
 * `Empty` is SCI16's two spare slots at the end of its table and `Dummy` is
 * SCI32's ten. Counting either as a named call inflates both the numerator and
 * the denominator — which is exactly how the figure this module replaces came
 * to say 138 where the table holds 137.
 */
const PLACEHOLDERS = new Set(['Empty', 'Dummy']);

export interface SciKernelCoverage {
  version: SciVersion;
  /** How many numbered slots the Version's table has. */
  slots: number;
  /** Distinct calls the table names, placeholders excluded. */
  named: string[];
  /** Named calls with a handler that reads what it was passed and acts on it. */
  implemented: string[];
  /**
   * Named calls whose handler answers the same value whatever a game passes.
   *
   * Not a defect list — some of these are finished — and not an implementation
   * either. `SCI_CONSTANT_KERNEL_NAMES` carries the distinction.
   */
  constant: string[];
  /** Named calls answered only by the unused-call stub, which is not an implementation. */
  unused: string[];
  /** Named calls nothing answers, which report themselves at runtime. */
  missing: string[];
}

const UNUSED = new Set(SCI_UNUSED_KERNEL_NAMES);
const CONSTANT = new Set(SCI_CONSTANT_KERNEL_NAMES);

/** What this engine answers at one Version. */
export function kernelCoverageFor(version: SciVersion): SciKernelCoverage {
  const table = kernelNamesFor(version);
  const named = [
    ...new Set(table.filter((name): name is string => !!name && !PLACEHOLDERS.has(name))),
  ].sort();

  const implemented: string[] = [];
  const constant: string[] = [];
  const unused: string[] = [];
  const missing: string[] = [];
  for (const name of named) {
    if (UNUSED.has(name)) unused.push(name);
    else if (typeof SCI_KERNEL[name] !== 'function') missing.push(name);
    else if (CONSTANT.has(name)) constant.push(name);
    else implemented.push(name);
  }

  return {
    version,
    slots: kernelTableSize(version),
    named,
    implemented,
    constant,
    unused,
    missing,
  };
}

/** Every Version on the axis, in axis order. */
export function kernelCoverage(): SciKernelCoverage[] {
  return SCI_VERSIONS.map(kernelCoverageFor);
}

/**
 * A handler keyed by a name no Version's table holds.
 *
 * The other direction of the same check, and the one that catches a rename: a
 * handler written as `SinDiv` when the table says `CosDiv` is not missing by
 * the count above — it is present and unreachable, which reads as working.
 *
 * Placeholders count as reachable here even though the coverage above excludes
 * them: SCI16's table really does name two `Empty` slots, so the handler that
 * answers them is reached and is not a stray.
 */
export function unreachableHandlers(): string[] {
  const reachable = new Set<string>();
  for (const version of SCI_VERSIONS) {
    for (const name of kernelNamesFor(version)) if (name) reachable.add(name);
  }
  return Object.keys(SCI_KERNEL)
    .filter((name) => !reachable.has(name))
    .sort();
}
