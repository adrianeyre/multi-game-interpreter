/**
 * `PSAD`: the audio Full Throttle interleaves through a cutscene's frames.
 *
 * The v7 games do not agree on how to carry a cutscene's sound. The Dig uses
 * `IACT`, which is 16-bit stereo in shift-coded blocks; Full Throttle uses
 * `PSAD`, which wraps a `SAUD` stream of plain 8-bit samples. A player that
 * handles only one of them is silent through every cutscene of the other game,
 * and silent is the failure that reads as "no sound in this version" rather
 * than as a bug. (#103, #107.)
 *
 * Each chunk opens with a ten-byte header, little-endian:
 *
 *     track     u16   which stream this belongs to
 *     index     u16   its position in that stream, from zero
 *     maxFrames u16
 *     flags     u16
 *     volume    u8
 *     pan       i8
 *
 * What follows depends on `index`, and this is the part worth stating plainly
 * because getting it wrong is not silence but a fraction of a second of sound:
 * **only index zero carries the `SAUD` container.** Every later chunk of the
 * same track is a bare continuation of the sample stream, appended to what came
 * before. A reader that expects the container in every chunk decodes the first
 * slice, finds no `SAUD` in the rest, and produces a cutscene that speaks one
 * syllable and then plays on mute.
 *
 * Inside `SAUD` the sub-chunks use the container's own framing — a tag and a
 * big-endian size — and are `STRK`, `SHDR`, `SDAT` and `SMRK`. Only `SDAT`
 * carries samples, and its declared size is the length of the *whole* stream,
 * not of this chunk, so it routinely runs past the end of the buffer holding
 * it. That is expected rather than malformed, and the size is clamped to what
 * is present.
 *
 * Samples are 8-bit **unsigned** mono at `PSAD_SAMPLE_RATE`. Reading them as
 * signed shifts silence to full scale, which is a loud buzz under the whole
 * scene; the rate is the SMUSH convention rather than anything the stream
 * declares, so an error there is audible as the wrong pitch, not as silence.
 * Confirming the pitch and the sync on real data is #107's Tier 2 line.
 *
 * (`SmushPlayer::handlePSAD`, `SaudChannel`.)
 */

import { IACT_SAMPLE_RATE } from './iact.js';

/**
 * Full Throttle's cutscene audio runs at The Dig's rate.
 *
 * Derived rather than repeated: both games' cutscene audio is queued into the
 * one buffer and played at the one rate, so two constants that happened to
 * disagree would play one game's cutscenes at the wrong pitch with nothing in
 * either file looking wrong.
 */
export const PSAD_SAMPLE_RATE = IACT_SAMPLE_RATE;

/** The little-endian header every `PSAD` chunk opens with. */
const PSAD_HEADER_BYTES = 10;

/** A tag and a big-endian size, as everything in a SMUSH file is framed. */
const SUBCHUNK_HEADER_BYTES = 8;

export interface PsadSlice {
  track: number;
  index: number;
  /**
   * Interleaved 16-bit stereo samples at `PSAD_SAMPLE_RATE`.
   *
   * Stereo although the stream is mono, so that both v7 games' cutscene audio
   * reaches the mixer in one shape at one rate. Duplicating a mono sample to
   * both channels is what "centred" means here; leaving one channel empty
   * would put every cutscene in Full Throttle on the left speaker only.
   */
  samples: Int16Array;
}

function tagAt(bytes: Uint8Array, at: number): string {
  let tag = '';
  for (let i = 0; i < 4; i++) tag += String.fromCharCode(bytes[at + i]);
  return tag;
}

/**
 * The sample bytes carried by one `PSAD` chunk, or null when its header will
 * not read.
 *
 * An empty sample run is a legitimate answer — a chunk can carry only stream
 * metadata — and is distinguished from a chunk that is too short to be a
 * `PSAD` at all, which the player reports.
 */
export function readPsadSlice(chunk: Uint8Array): PsadSlice | null {
  if (chunk.length < PSAD_HEADER_BYTES) return null;

  const view = new DataView(chunk.buffer, chunk.byteOffset);
  const track = view.getUint16(0, true);
  const index = view.getUint16(2, true);

  const raw = index === 0 ? sampleBytesFromContainer(chunk) : chunk.subarray(PSAD_HEADER_BYTES);

  return { track, index, samples: toStereo16(raw) };
}

/**
 * Walks the `SAUD` container in an index-zero chunk down to its `SDAT` bytes.
 *
 * Returns an empty run rather than null when there is no `SDAT` yet: a first
 * chunk that carries only `STRK` and `SHDR` is well-formed, and the samples
 * begin in the chunk after it.
 */
function sampleBytesFromContainer(chunk: Uint8Array): Uint8Array {
  const empty = chunk.subarray(0, 0);
  if (chunk.length < PSAD_HEADER_BYTES + SUBCHUNK_HEADER_BYTES) return empty;
  if (tagAt(chunk, PSAD_HEADER_BYTES) !== 'SAUD') return empty;

  const view = new DataView(chunk.buffer, chunk.byteOffset);
  let at = PSAD_HEADER_BYTES + SUBCHUNK_HEADER_BYTES;

  while (at + SUBCHUNK_HEADER_BYTES <= chunk.length) {
    const tag = tagAt(chunk, at);
    const declared = view.getUint32(at + 4, false);
    const dataAt = at + SUBCHUNK_HEADER_BYTES;

    if (tag === 'SDAT') {
      // Deliberately *not* bounds-checked the way the tags above are.
      // `SDAT` declares the length of the whole stream, which continues into
      // the chunks after this one, so over-declaring is the normal case and
      // rejecting it would silence every cutscene. Clamped explicitly rather
      // than leaning on `subarray` doing it, so the intent is on the page.
      const available = chunk.length - dataAt;
      return chunk.subarray(dataAt, dataAt + Math.min(declared, available));
    }

    if (dataAt + declared > chunk.length) return empty;
    at = dataAt + declared + (declared & 1);
  }

  return empty;
}

/** 8-bit unsigned mono to interleaved 16-bit signed stereo. */
function toStereo16(raw: Uint8Array): Int16Array {
  const out = new Int16Array(raw.length * 2);
  for (let i = 0; i < raw.length; i++) {
    const sample = (raw[i] - 128) << 8;
    out[i * 2] = sample;
    out[i * 2 + 1] = sample;
  }
  return out;
}
