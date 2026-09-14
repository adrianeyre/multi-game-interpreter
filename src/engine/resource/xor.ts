/**
 * SCUMM data files are "encrypted" with a single-byte XOR. It was never meant
 * to be security, only to stop players browsing the strings with a hex editor.
 *
 * v5 (Monkey Island 2, Indy 4, Fate of Atlantis) uses 0x69. v4 (Monkey Island 1
 * VGA, Loom CD) uses 0x69 as well; some v3 titles use 0xFF and a few releases
 * ship unencrypted.
 */
export const XOR_NONE = 0x00;
export const XOR_V4_V5 = 0x69;
export const XOR_V3 = 0xff;

export const CANDIDATE_XOR_KEYS = [XOR_V4_V5, XOR_NONE, XOR_V3] as const;

/** XORs in place and returns the same array, for chaining. */
export function applyXor(data: Uint8Array, key: number): Uint8Array {
  if (key === 0) return data;
  for (let i = 0; i < data.length; i++) data[i] ^= key;
  return data;
}

/**
 * A decrypted copy, or the input itself when there is nothing to decrypt.
 *
 * A zero key means the file is stored plain — every v7 release, and a few v3
 * ones — so the copy would be a byte-for-byte duplicate made by XORing with 0.
 * Returning the input is safe for the same reason the copy is made in the first
 * place: the copy exists so a source that caches its buffer is not left holding
 * XORed bytes, and a caller that never writes cannot do that damage.
 */
export function decryptCopy(data: Uint8Array, key: number): Uint8Array {
  if (key === 0) return data;
  const out = new Uint8Array(data.length);
  decryptRange(out, data, key, 0, data.length);
  return out;
}

/**
 * Decrypts `data[start..end)` into the same positions of `out`.
 *
 * Exists so a large file can be decrypted a slice at a time, letting the caller
 * report progress and let the browser paint between slices instead of blocking
 * for the whole 6-10 MB.
 */
export function decryptRange(
  out: Uint8Array,
  data: Uint8Array,
  key: number,
  start: number,
  end: number,
): void {
  const stop = Math.min(end, data.length);
  if (key === 0) {
    out.set(data.subarray(start, stop), start);
    return;
  }
  for (let i = start; i < stop; i++) out[i] = data[i] ^ key;
}

export const KNOWN_ROOT_TAGS = ['LECF', 'RNAM', 'MAXS', 'LOFF', 'DROO', '0RCS', '0RMS'] as const;

const ROOT_TAGS = new Set<string>(KNOWN_ROOT_TAGS);

/**
 * Finds the XOR key by trying each candidate and checking whether the first
 * four bytes decode to a tag the format actually uses.
 *
 * Cheap and reliable: the tag space is sparse enough that a wrong key produces
 * random bytes, and picking the key by trial beats asking the user which
 * edition of the game they own.
 *
 * Returns `null` when no candidate produces a known tag, which is the whole
 * point of the return type. This used to fall back to `XOR_V4_V5` and report
 * success, so a file that was not SCUMM data at all — a Sierra dump whose
 * files happen to be named `.000`/`.001` — got a key nobody had any evidence
 * for, was read and decrypted in full with it, and only fell over several
 * stages later on a container tag. Finding no key *is* the answer: the trial
 * covers every key the releases use, so nothing matching means these are not
 * the bytes of a SCUMM index.
 */
export function detectXorKey(header: Uint8Array): number | null {
  if (header.length < 4) return null;

  for (const key of CANDIDATE_XOR_KEYS) {
    const tag = String.fromCharCode(
      header[0] ^ key,
      header[1] ^ key,
      header[2] ^ key,
      header[3] ^ key,
    );
    if (ROOT_TAGS.has(tag)) return key;
  }
  return null;
}
