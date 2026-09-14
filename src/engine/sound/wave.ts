/**
 * RIFF/WAVE PCM, read and written, in one place for the three families.
 *
 * A codec rather than a record, which is what ADR 0036 permits to cross an
 * engine boundary — and this one has to, because three unrelated things in
 * this project speak WAVE and none of them is SCUMM, AGOS or Broken Sword
 * specifically. AGOS's Windows talkies ship their speech as PCM WAVE; Broken
 * Sword hands a decoded line to the browser as one; and an author replacing a
 * recording drops in whatever their audio editor wrote, which is a WAVE more
 * often than it is anything else.
 *
 * ## Sixteen-bit signed, whatever the file says
 *
 * `readWavePcm` answers in `Int16Array` because that is the one representation
 * every caller here can use without losing anything: the 8-bit form is
 * unsigned with 128 for silence, and `(byte - 128) << 8` is exactly the same
 * number `(byte - 128) / 128` would give a float, scaled. Callers that want
 * floats divide by 32,768 and get back precisely what a direct float decode
 * would have produced.
 *
 * Only the first channel of a stereo file is read. Not a shortcut: every
 * recording any of these games plays is mono, so a stereo replacement is a
 * file an author exported without noticing, and taking the left channel is
 * what an editor does with one.
 */

/** A decoded PCM stream, with the numbers the container stated. */
export interface WavePcm {
  readonly sampleRate: number;
  /** Channels the file declared, though only the first was read. */
  readonly channels: number;
  /** Bits per sample the file declared: 8 or 16. */
  readonly bits: number;
  /** The first channel's samples, as signed 16-bit. */
  readonly samples: Int16Array;
}

/**
 * Reads a PCM WAVE, or null when the bytes are not one.
 *
 * Null rather than throwing for the reason every reader in this project
 * answers null: the caller knows what it asked for and can say so, where a
 * thrown error from deep inside a codec names the codec.
 *
 * Chunks are walked rather than assumed at fixed offsets, and the walk is
 * word-aligned — an odd-sized chunk is followed by a pad byte, and a reader
 * that ignores it walks off into the middle of the next header.
 */
export function readWavePcm(data: Uint8Array): WavePcm | null {
  const text = new TextDecoder('latin1');
  if (data.length < 12) return null;
  if (text.decode(data.subarray(0, 4)) !== 'RIFF') return null;
  if (text.decode(data.subarray(8, 12)) !== 'WAVE') return null;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 12;
  let sampleRate = 0;
  let channels = 1;
  let bits = 8;
  let body: Uint8Array | undefined;

  while (at + 8 <= data.length) {
    const id = text.decode(data.subarray(at, at + 4));
    const size = view.getUint32(at + 4, true);
    const chunk = at + 8;
    if (id === 'fmt ' && chunk + 16 <= data.length) {
      channels = view.getUint16(chunk + 2, true);
      sampleRate = view.getUint32(chunk + 4, true);
      bits = view.getUint16(chunk + 14, true);
    } else if (id === 'data') {
      // Clamped to what the file actually holds: a truncated download states
      // the length it was going to have, and reading to it walks off the end.
      body = data.subarray(chunk, Math.min(chunk + size, data.length));
    }
    at = chunk + size + (size & 1);
  }

  if (!body || sampleRate <= 0 || channels <= 0) return null;
  if (bits !== 8 && bits !== 16) return null;

  const stride = channels * (bits === 16 ? 2 : 1);
  const frames = Math.floor(body.length / stride);
  const samples = new Int16Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    const from = frame * stride;
    samples[frame] =
      bits === 16 ? ((body[from]! | (body[from + 1]! << 8)) << 16) >> 16 : (body[from]! - 128) << 8;
  }
  return { sampleRate, channels, bits, samples };
}

/**
 * Sixteen-bit mono PCM wrapped in the smallest WAVE that plays everywhere.
 *
 * Forty-four bytes of header and the samples: `RIFF`, a `fmt ` chunk declaring
 * PCM, and `data`. The inverse of `readWavePcm` for the one shape this project
 * ever writes.
 */
export function writeWavePcm(samples: Int16Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const put = (at: number, text: string): void => {
    for (let index = 0; index < text.length; index++) bytes[at + index] = text.charCodeAt(index);
  };

  put(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  put(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let at = 0; at < samples.length; at++) view.setInt16(44 + at * 2, samples[at]!, true);
  return bytes;
}

/**
 * Resamples by linear interpolation, for a replacement recorded at another rate.
 *
 * Here because the alternative is worse in both directions. Broken Sword's
 * speech is 11,025 Hz and the engine states that rate rather than reading it,
 * so a 44,100 Hz replacement written in unchanged plays at a quarter speed —
 * and refusing every file an ordinary audio editor produces would make the
 * Replace button useless for the one format everybody has.
 *
 * Linear rather than windowed: this is an editor writing a file, not a
 * playback path, and the artefact of linear interpolation on speech is a
 * little high-frequency dullness rather than anything audible as wrong.
 */
export function resampleWavePcm(samples: Int16Array, from: number, to: number): Int16Array {
  if (from === to || from <= 0 || to <= 0 || samples.length === 0) return samples;
  const frames = Math.max(1, Math.round((samples.length * to) / from));
  const out = new Int16Array(frames);
  const step = (samples.length - 1) / Math.max(1, frames - 1);
  for (let at = 0; at < frames; at++) {
    const position = at * step;
    const left = Math.floor(position);
    const right = Math.min(samples.length - 1, left + 1);
    const fraction = position - left;
    out[at] = Math.round(samples[left]! * (1 - fraction) + samples[right]! * fraction);
  }
  return out;
}
