/**
 * AGOS's numbered sound effects.
 *
 * The last subsystem the VGA host seam had nothing behind it for. `PLAY_SOUND`
 * and `PLAY_EFFECT` name an effect by number, and with no resource open there
 * was no sample to play, so both were recorded by name instead — honest, and no
 * substitute for a door that creaks.
 *
 * ## The container is the speech container, which was checked rather than hoped
 *
 * Simon 1's CD release ships `effects.voc` beside `simon.voc`, and it turns out
 * to use the **same offset-table layout** the speech reader already handles: a
 * table of 32-bit offsets at the front, each entry the bytes of one Creative
 * Voice File. That is not an assumption — reading Simon 1's DOS CD demo through
 * `readSpeechIndex` yields 140 entries of which **139 decode as VOC**, which is
 * the shape agreeing rather than a filename looking familiar.
 *
 * So this is a thin layer over `readSpeechIndex` and `decodeVoc` rather than a
 * second container reader. Writing a fresh one would have been a second place
 * for the same off-by-four to live.
 *
 * ## Two container fills, and the reader takes either
 *
 * The DOS CD release fills it with **VOC** clips. Simon 1's Windows release
 * ships its effects as `SFXXXX02` … `SFXXXX29` — one file per `TABLES` file,
 * swapped as the game loads a new part of itself — and those hold **WAV**
 * clips in the same offset table. So the signature test below accepts both
 * rather than only the one the first release seen happened to use: filtering to
 * VOC alone rejected every entry of a Windows release, so a game with 139
 * sounds in front of it reported that it had none.
 *
 * ## The one entry that is not a sound
 *
 * Entry 0's offset is 0, so the span it names is the offset table itself. It
 * decodes as nothing, and a reader that handed it to the mixer would play the
 * table as audio. Rather than special-casing index 0 — which would be a guess
 * about layout — every entry is checked for the VOC signature and the ones
 * without it are reported as absent. That also covers a release whose table has
 * other holes in it, without needing to know where they are.
 */

import { decodeVoc, decodeWav, readSpeechIndex, speechKind, type DecodedSpeech } from './speech.js';

export interface EffectEntry {
  readonly index: number;
  readonly offset: number;
  readonly length: number;
}

export interface EffectsIndex {
  /** Every entry whose bytes are really a sound. */
  readonly entries: readonly EffectEntry[];
  /** The bytes of one effect, or undefined where the release ships none. */
  read(index: number): Uint8Array | undefined;
  /** One effect decoded, or undefined where there is nothing to decode. */
  decode(index: number): DecodedSpeech | undefined;
}

/**
 * Reads an effects resource.
 *
 * `base` is passed through for the same reason the speech reader takes one:
 * some releases put the table after other data in the same file.
 */
export function readEffectsIndex(
  data: Uint8Array,
  options: { base?: number; bigEndian?: boolean } = {},
): EffectsIndex {
  const speech = readSpeechIndex(data, options);

  // Filtered by what the bytes *are*, not by index. See the note above: entry 0
  // names the offset table, and playing that as audio is the failure this
  // avoids without guessing at the layout.
  const entries = speech.entries.filter((entry) => {
    const bytes = speech.read(entry.index);
    if (bytes === undefined) return false;
    const kind = speechKind(bytes);
    return kind === 'voc' || kind === 'wav';
  });

  const known = new Set(entries.map((entry) => entry.index));

  return {
    entries,
    read(index) {
      return known.has(index) ? speech.read(index) : undefined;
    },
    decode(index) {
      const bytes = known.has(index) ? speech.read(index) : undefined;
      if (!bytes) return undefined;
      return speechKind(bytes) === 'wav' ? decodeWav(bytes) : decodeVoc(bytes);
    },
  };
}
