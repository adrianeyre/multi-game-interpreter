/**
 * A cheap, stable fingerprint of a file's bytes.
 *
 * ADR 0034 sends the editor back to the player for the game folder rather than
 * keeping a copy of a talkie's resources in IndexedDB, and says the re-supply
 * "needs a same-game check with teeth" — because a different game's zones do
 * not fail to render, they render as plausible nonsense, and that is worse than
 * an error. This is the teeth: the base file is fingerprinted at import and the
 * folder offered later has to produce the same number.
 *
 * FNV-1a, 32-bit, and deliberately not a cryptographic hash. Nothing here is
 * defending against a forged `GAMEPC`; it is separating "the folder you meant"
 * from "a different release of the same title", and for that a fast synchronous
 * mix over the whole file is the right tool. `crypto.subtle.digest` is the
 * other candidate and it is asynchronous, which would make every caller that
 * only wants to compare two files asynchronous with it.
 *
 * The length travels beside the hash rather than being folded into it, so a
 * mismatch can say *which* thing differs — "that file is 4 KB shorter" is a
 * sentence a person can act on and "the hashes differ" is not.
 */

export interface Fingerprint {
  readonly bytes: number;
  readonly hash: number;
}

const OFFSET_BASIS = 0x811c9dc5;
const PRIME = 0x01000193;

export function fingerprintOf(data: Uint8Array): Fingerprint {
  let hash = OFFSET_BASIS;
  for (const byte of data) {
    hash ^= byte;
    // `Math.imul` because the product overflows 32 bits and `*` would silently
    // go through doubles, which loses the low bits this depends on.
    hash = Math.imul(hash, PRIME);
  }
  // Back into an unsigned 32-bit value, so the number stored in a Project is
  // the same one whichever way it was computed.
  return { bytes: data.length, hash: hash >>> 0 };
}

/**
 * Why two fingerprints differ, in words, or null when they match.
 *
 * A sentence rather than a boolean, for the reason above: the caller is about
 * to refuse a folder the author chose on purpose, and "that is not this game"
 * with no evidence reads as the editor being broken.
 */
export function describeFingerprintMismatch(
  expected: Fingerprint,
  actual: Fingerprint,
  fileName: string,
): string | null {
  if (expected.bytes !== actual.bytes) {
    return (
      `${fileName} in that folder is ${actual.bytes} bytes and this project was built ` +
      `from one of ${expected.bytes}. That is a different release, and its resources ` +
      `are at different offsets — so its art would open as plausible nonsense rather ` +
      `than fail.`
    );
  }
  if (expected.hash !== actual.hash) {
    return (
      `${fileName} in that folder is the right size but not the same file. This project ` +
      `was built from a different copy, and editing its art against this one would put ` +
      `pixels in the wrong places.`
    );
  }
  return null;
}
