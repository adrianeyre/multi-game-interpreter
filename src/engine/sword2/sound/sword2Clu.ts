/**
 * Broken Sword II's streamed sound container, which no demo ships.
 *
 * Speech and music in this family are **not** resources. Every other sound is
 * — an effect is a `WAV_FILE` with an id, `resource.tab` says which cluster
 * holds it and `Sword2Resources` reads it — but a retail disc keeps its lines
 * and its tunes in files of their own that the resource index never mentions:
 * `SPEECH1.CLU`, `SPEECH2.CLU`, `MUSIC1.CLU`, `MUSIC2.CLU`, opened by name and
 * addressed by the same text-line id the script already carries
 * (`Sound::playCompSpeech`, ScummVM `engines/sword2/music.cpp:750`).
 *
 * The two layouts cannot be the same file read two ways, which is worth
 * stating because this project used to model speech as a cluster: the first
 * four bytes of a resource cluster are the byte offset of its own tail table,
 * and the first four bytes of one of these are the **number of entries** in an
 * index that follows immediately. A reader that guessed wrong would seek to
 * byte 5,000-and-something of a 500 MB file and find audio.
 *
 * ## The layout
 *
 * ```
 * uint32  count            how many entries the index has
 * (four bytes skipped)     the reader seeks to `entrySize * 4`, and for this
 *                          mode `entrySize` is 2 — so the table starts at 8
 * count * {
 *   uint32 pos            byte offset of the payload, 0 when never recorded
 *   uint32 len            byte length of the payload, 0 when never recorded
 * }
 * ...payloads
 * ```
 *
 * A payload is `len` bytes and decodes to `len - 1` samples, 22,050 Hz mono.
 *
 * ## The codec
 *
 * Revolution's own, and unrelated to the 16-bit RLE Broken Sword 1 uses for
 * its speech — a fixed one byte per sample, holding a delta from the sample
 * before it:
 *
 * - the first **two** bytes are sample 0, little-endian;
 * - every byte after that is `SSSS_nAAA`: `AAA` an amplitude of 0..7, `SSSS`
 *   a shift of 0..15, `n` set to subtract rather than add.
 *
 * So the step is `(amplitude << shift)`, truncated to sixteen bits as the
 * original's `uint16 delta` truncates it, and the running sample wraps at
 * sixteen bits too. Both of those are load-bearing: `7 << 15` is 0 after
 * truncation, not 229,376, and an encoder that reasoned in wider arithmetic
 * would write bytes this decoder disagrees with.
 *
 * ## What this is measured against
 *
 * The decoder is ScummVM's `CLUInputStream::refill` transcribed — no install
 * reachable here ships a container to read, which `docs/editor-parity.md`
 * §27a says on the surface as well as here. What _is_ measured is the pair:
 * `encodeSword2Clu` then `decodeSword2Clu` over real recordings out of both
 * demos, reported as sample error rather than as bytes, because a delta codec
 * with eight amplitudes is lossy by construction and a byte comparison would
 * be measuring the wrong thing.
 */

/** Raised when a container cannot be read, with what was wrong. */
export class Sword2CluError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Sword2CluError';
  }
}

/** Every release plays these at 22,050 Hz mono (`sound.h:230`). */
export const SWORD2_CLU_RATE = 22050;

/** Where the entry table starts: `entrySize * 4` with `entrySize` 2. */
export const SWORD2_CLU_TABLE_AT = 8;

/**
 * The largest index this reader will believe.
 *
 * A retail disc's speech container indexes the whole text id space, which is
 * tens of thousands of lines; a file whose first word is larger than this is
 * not a container at all, and believing it would mean allocating from a number
 * that came out of arbitrary bytes.
 */
const MAX_ENTRIES = 1 << 20;

/** One recording the container's index names. */
export interface Sword2CluEntry {
  /** Its position in the index, which is the id a script plays it by. */
  readonly index: number;
  readonly at: number;
  /** Payload bytes. The samples are one fewer, the first taking two bytes. */
  readonly length: number;
}

/** A container's index, read without its payloads. */
export interface Sword2CluIndex {
  readonly file: string;
  /** How many entries the index declares, recorded and unrecorded alike. */
  readonly count: number;
  /** Bytes the header and index occupy, which is where payloads may begin. */
  readonly indexBytes: number;
  /** Every entry that names a recording, in index order. */
  entries(): Sword2CluEntry[];
  /** One entry, or null where the release recorded nothing under that id. */
  locate(index: number): Sword2CluEntry | null;
}

/**
 * Reads a container's index, or answers null when this is not one.
 *
 * Null rather than a throw, because the caller is usually asking *whether* a
 * file is a container — the folder holds whatever it holds and a `.clu` in it
 * may be an ordinary resource cluster.
 *
 * `bytes` may be a prefix: only the header and the table are read, which is
 * the point of separating this from the rebuild. A speech container is half a
 * gigabyte and an editor listing what is in it should not hold one.
 */
export function parseSword2CluIndex(
  file: string,
  bytes: Uint8Array,
  fileLength?: number | null,
): Sword2CluIndex | null {
  // How far a payload may run: the file's own length, which is `bytes`' when
  // the whole file is in hand. **Null means unknown** — a caller that read
  // only the header and the table out of a folder cannot say, and passing
  // `bytes.length` for it would reject every payload in the file. The bound
  // that survives either way is "a payload does not start inside the index",
  // which is the check that catches reading some other layout as this one.
  const limit = fileLength === null ? undefined : (fileLength ?? bytes.length);
  if (bytes.length < SWORD2_CLU_TABLE_AT + 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  if (count === 0 || count > MAX_ENTRIES) return null;
  const indexBytes = SWORD2_CLU_TABLE_AT + count * 8;
  if (bytes.length < indexBytes) return null;
  if (limit !== undefined && limit < indexBytes) return null;

  const table: Sword2CluEntry[] = [];
  let recorded = 0;
  for (let index = 0; index < count; index++) {
    const at = view.getUint32(SWORD2_CLU_TABLE_AT + index * 8, true);
    const length = view.getUint32(SWORD2_CLU_TABLE_AT + index * 8 + 4, true);
    // The engine's own test for "no such recording" is `!pos || !len`, so an
    // entry that fails it is carried as a slot rather than as a recording.
    if (at === 0 || length === 0) continue;
    // A payload that starts inside the index, or runs off the end of the file,
    // is what reading some other layout as this one looks like.
    if (at < indexBytes) return null;
    if (limit !== undefined && at + length > limit) return null;
    if (length < 3) return null;
    table.push({ index, at, length });
    recorded++;
  }
  if (recorded === 0) return null;

  const byIndex = new Map(table.map((entry) => [entry.index, entry] as const));
  return {
    file,
    count,
    indexBytes,
    entries: () => [...table],
    locate: (index: number) => byIndex.get(index) ?? null,
  };
}

/** The byte each of the 256 codes steps by, truncated as the original is. */
const STEPS = Uint16Array.from(
  { length: 256 },
  (_unused, code) => ((code & 0x07) << ((code >> 4) & 0x0f)) & 0xffff,
);

/** Whether a code subtracts its step rather than adding it. */
function subtracts(code: number): boolean {
  return (code & 0x08) !== 0;
}

/**
 * The samples a payload holds.
 *
 * Sixteen-bit wrapping throughout, because that is what the original does: the
 * running value is a `uint16` and the sample handed to the mixer is that same
 * word read as signed.
 */
export function decodeSword2Clu(payload: Uint8Array): Int16Array {
  if (payload.length < 3) {
    throw new Sword2CluError(
      `A Broken Sword II recording is two bytes of first sample and one byte per sample after ` +
        `it, so ${payload.length} bytes is not a recording this can decode.`,
    );
  }
  const out = new Int16Array(payload.length - 1);
  let previous = (payload[0]! | (payload[1]! << 8)) & 0xffff;
  out[0] = (previous << 16) >> 16;
  for (let at = 2; at < payload.length; at++) {
    const code = payload[at]!;
    const step = STEPS[code]!;
    previous = (subtracts(code) ? previous - step : previous + step) & 0xffff;
    out[at - 1] = (previous << 16) >> 16;
  }
  return out;
}

/**
 * Writes samples as a payload this container's reader will play.
 *
 * Greedy and per-sample optimal: the step that lands closest to the sample
 * that was asked for, chosen against the value the decoder will actually hold
 * rather than against the one that was wanted. That difference is what stops
 * the error accumulating — every sample is encoded as a delta from what the
 * decoder has, so a step that fell short is made up by the next one.
 *
 * All 256 codes are tried for each sample. There are 256 of them, several
 * describe the same step, and a cleverer search would be a table this file
 * would then have to justify.
 */
export function encodeSword2Clu(samples: Int16Array): Uint8Array {
  if (samples.length === 0) {
    throw new Sword2CluError(
      `A recording with no samples in it cannot be written: the container states a byte length ` +
        `and the engine plays one sample fewer, so an empty one is an entry that reads as absent.`,
    );
  }
  const out = new Uint8Array(samples.length + 1);
  let previous = samples[0]! & 0xffff;
  out[0] = previous & 0xff;
  out[1] = (previous >> 8) & 0xff;

  for (let at = 1; at < samples.length; at++) {
    const wanted = samples[at]!;
    let bestCode = 0;
    let bestValue = previous;
    let bestError = Infinity;
    for (let code = 0; code < 256; code++) {
      const step = STEPS[code]!;
      const value = (subtracts(code) ? previous - step : previous + step) & 0xffff;
      const error = Math.abs(((value << 16) >> 16) - wanted);
      if (error < bestError) {
        bestError = error;
        bestCode = code;
        bestValue = value;
        if (error === 0) break;
      }
    }
    out[at + 1] = bestCode;
    previous = bestValue;
  }
  return out;
}
