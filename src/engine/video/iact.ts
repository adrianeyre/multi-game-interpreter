/**
 * `IACT`: the audio interleaved through a SMUSH sequence's frames.
 *
 * Not the same path as the `.BUN` bundles. A bundle is asked for by name and
 * decoded on its own; `IACT` arrives a slice at a time inside the video, which
 * is what makes it stay in step with the picture — and what makes drift the
 * failure mode here rather than silence.
 *
 * The chunk opens with four 16-bit fields, and only one combination of the
 * first two means audio at all:
 *
 *     code     u16   8 for audio
 *     flags    u16   46 for audio
 *     unknown  i16
 *     userId   u16   which track: speech, music or an effect
 *
 * Anything else is an interactive-sequence instruction rather than sound —
 * Full Throttle's bike fights drive their overlays through `IACT` — so a reader
 * that assumed audio would decode gameplay data as samples. (#103.)
 *
 * (`SmushPlayer::handleIACT`.)
 */

/** The pair that means "this chunk is audio". */
const AUDIO_CODE = 8;
const AUDIO_FLAGS = 46;

/** Interleaved audio is 22050 Hz, 16-bit, stereo. */
export const IACT_SAMPLE_RATE = 22050;

/** One decoded block is 1024 stereo frames. */
const BLOCK_FRAMES = 1024;

export interface IactHeader {
  code: number;
  flags: number;
  userId: number;
  /** True only for the code/flags pair that means audio. */
  isAudio: boolean;
}

export function readIactHeader(chunk: Uint8Array): IactHeader | null {
  if (chunk.length < 8) return null;
  const view = new DataView(chunk.buffer, chunk.byteOffset);
  const code = view.getUint16(0, true);
  const flags = view.getUint16(2, true);
  const userId = view.getUint16(6, true);
  return { code, flags, userId, isAudio: code === AUDIO_CODE && flags === AUDIO_FLAGS };
}

/**
 * The audio payload of an `IACT` chunk, past its own eighteen-byte header.
 *
 * The audio form carries six more bytes than the header above — a track id, an
 * index, a frame count and a 32-bit size — before the block stream starts.
 * Returns null for a chunk that is not audio, rather than a best guess.
 */
export function iactAudioPayload(chunk: Uint8Array): Uint8Array | null {
  const header = readIactHeader(chunk);
  if (!header?.isAudio) return null;
  if (chunk.length < 18) return null;
  return chunk.subarray(18);
}

/**
 * Decodes one block of interleaved audio into interleaved 16-bit samples.
 *
 * A block is a big-endian length, then a byte carrying **two shift amounts** in
 * its nibbles — the high nibble for the left channel and the low for the right
 * — then 2048 codes, alternating channels. A code of 0x80 escapes to a raw
 * big-endian sample; anything else is a signed byte shifted left by that
 * channel's amount.
 *
 * Two shifts rather than one is the detail worth stating: the channels are
 * scaled independently, so using one for both gives audio that is quiet on one
 * side and clipped on the other — plausible enough to be mistaken for a bad
 * recording.
 */
export function decodeIactBlock(block: Uint8Array): Int16Array | null {
  // A length, a shift byte, and two codes per frame at minimum.
  if (block.length < 3) return null;

  const leftShift = block[2] >> 4;
  const rightShift = block[2] & 0x0f;

  const out = new Int16Array(BLOCK_FRAMES * 2);
  let read = 3;
  let write = 0;

  for (let frame = 0; frame < BLOCK_FRAMES; frame++) {
    for (const shift of [leftShift, rightShift]) {
      if (read >= block.length) return out.subarray(0, write) as Int16Array;
      const code = block[read++];
      if (code === 0x80) {
        if (read + 1 >= block.length) return out.subarray(0, write) as Int16Array;
        out[write++] = (block[read] << 8) | block[read + 1];
        read += 2;
      } else {
        // Signed, then shifted: reading it unsigned turns the whole lower half
        // of the waveform into loud positive values, which is audible as a
        // buzz rather than as silence.
        const signed = code < 0x80 ? code : code - 0x100;
        out[write++] = (signed << shift) & 0xffff;
      }
    }
  }

  return out;
}

/** How many bytes the block starting at `at` occupies, including its length. */
export function iactBlockLength(payload: Uint8Array, at: number): number | null {
  if (at + 2 > payload.length) return null;
  return ((payload[at] << 8) | payload[at + 1]) + 2;
}
