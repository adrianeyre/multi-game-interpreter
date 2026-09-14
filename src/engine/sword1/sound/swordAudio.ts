/**
 * Broken Sword's audio formats: RIFF samples, and the speech compression.
 *
 * Pure decoders, like `swordDecode.ts` and for the same reason: the editor's
 * audio surface needs them without an `AudioContext`, and a test needs them
 * without either.
 *
 * ## Two formats, and only one of them is unusual
 *
 * Sound effects and music are plain RIFF/WAVE — 8- or 16-bit PCM, mono or
 * stereo — so `parseWave` is a header walk and nothing more.
 *
 * Speech is a **16-bit RLE over samples** wrapped in a WAVE header whose
 * `data` chunk holds compressed bytes rather than samples. Each run is a signed
 * 16-bit count: negative means "repeat the next sample `-count` times", positive
 * means "copy the next `count` samples". That is the whole scheme, and its one
 * trap is that the run counts are *sample* counts and the stream is indexed in
 * 16-bit units throughout — an implementation that works in bytes is off by a
 * factor of two on every run after the first.
 */

/** Raised when a sample will not parse, with what was wrong. */
export class SwordAudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwordAudioError';
  }
}

/** A decoded sample, ready for an `AudioBuffer` or a test's assertions. */
export interface SwordSample {
  readonly sampleRate: number;
  readonly channels: number;
  /** Interleaved samples in -1..1, which is what WebAudio wants. */
  readonly data: Float32Array;
  /** Frames, so a caller can size a buffer without dividing. */
  readonly frames: number;
}

function tag(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

/** Where a named chunk's payload starts and how long it is, or null. */
export function findChunk(
  bytes: Uint8Array,
  want: string,
  from = 12,
): { at: number; length: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = from;
  while (at + 8 <= bytes.length) {
    const name = tag(bytes, at);
    const length = view.getUint32(at + 4, true);
    if (name === want) return { at: at + 8, length };
    // Chunks are word-aligned, and a reader that ignores the pad byte walks
    // into the middle of the next header on any odd-length chunk.
    at += 8 + length + (length & 1);
  }
  return null;
}

/** Reads a RIFF/WAVE sample. 8-bit unsigned and 16-bit signed PCM. */
export function parseWave(bytes: Uint8Array): SwordSample {
  if (bytes.length < 44 || tag(bytes, 0) !== 'RIFF' || tag(bytes, 8) !== 'WAVE') {
    throw new SwordAudioError(
      `This is not a RIFF/WAVE sample: it begins "${bytes.length >= 4 ? tag(bytes, 0) : '??'}".`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fmt = findChunk(bytes, 'fmt ');
  const data = findChunk(bytes, 'data');
  if (!fmt || !data) {
    throw new SwordAudioError(
      `This WAVE sample has no ${fmt ? 'data' : 'fmt '} chunk, so it cannot be played.`,
    );
  }
  const channels = view.getUint16(fmt.at + 2, true);
  const sampleRate = view.getUint32(fmt.at + 4, true);
  const bits = view.getUint16(fmt.at + 14, true);
  if (channels < 1 || channels > 2 || (bits !== 8 && bits !== 16)) {
    throw new SwordAudioError(
      `This WAVE sample is ${bits}-bit with ${channels} channels, which Broken Sword does not ` +
        `ship and this reader does not decode.`,
    );
  }

  const available = Math.min(data.length, bytes.length - data.at);
  const frames = Math.floor(available / ((bits / 8) * channels));
  const out = new Float32Array(frames * channels);
  if (bits === 8) {
    for (let at = 0; at < out.length; at++) {
      // 8-bit PCM is unsigned with 128 as silence.
      out[at] = (bytes[data.at + at] - 128) / 128;
    }
  } else {
    for (let at = 0; at < out.length; at++) {
      out[at] = view.getInt16(data.at + at * 2, true) / 32768;
    }
  }
  return { sampleRate, channels, data: out, frames };
}

/**
 * Which of the two ways a container states a line's uncompressed length.
 *
 * `wave` is `SPEECH1.CLU` and `SPEECH.CLU`: a `u32` immediately after the
 * `data` tag, and the RLE stream begins after it. `demo` is `COWS.MAD`, where
 * the length is *inside the stream* — the first one or two runs decode to the
 * length's own words — so the reader starts at the tag and the original blanks
 * the first two samples afterwards (`sound.cpp:640` and `:713`). Reading a demo
 * line the retail way takes a compressed word as a length and asks for an
 * output buffer of some hundreds of megabytes, which is why this is a
 * parameter rather than a guess.
 */
export type Sword1SpeechMode = 'wave' | 'demo';

/**
 * The longest line this will decode: ten minutes at the family's 11.025 kHz.
 *
 * A bound rather than a fact about the format, and here because the length is
 * read out of the file: a container this reader has mis-identified yields a
 * plausible-looking word that sizes an allocation, and an error naming the
 * length is worth incomparably more than an out-of-memory kill.
 */
const MAX_SPEECH_SAMPLES = 11025 * 600;

/**
 * Expands Broken Sword's compressed speech into 16-bit samples.
 *
 * `bigEndian` is for the Macintosh releases, some of which store the speech
 * words big-endian *while sharing the container format*. ScummVM detects it by
 * decoding a sample both ways and seeing which one stays in bounds; that
 * detection is `checkSpeechEndianness` below, and it exists because the files
 * carry no flag.
 */
/** A speech stream taken apart: where its runs start and what they produce. */
export interface Sword1SpeechStream {
  /** Byte offset of the first run word, past the `data` tag and any length. */
  readonly runsAt: number;
  /**
   * Every sample the runs produce.
   *
   * Which can be *more* than the container states: the demo's lines state the
   * length of the audio and the two words holding that length are themselves
   * the first two samples of the stream, so the last two samples of every line
   * fall past the stated end and are never played. They are still in the file,
   * and re-encoding without them would not give the bytes back.
   */
  readonly samples: Int16Array;
  /** The sample count the container states, which is what playback uses. */
  readonly declared: number;
}

/** Where the `data` tag is, scanned the way the original scans for it. */
function speechDataTag(bytes: Uint8Array): number {
  // The compressed speech's header is not always a well-formed RIFF, and
  // ScummVM scans the first hundred bytes for the tag. Doing the same is what
  // reads the files that ship.
  for (let at = 0; at < Math.min(100, bytes.length - 4); at++) {
    if (tag(bytes, at) === 'data') return at;
  }
  throw new SwordAudioError(
    `This speech sample has no "data" tag in its first hundred bytes, so it is not Broken ` +
      `Sword's compressed speech.`,
  );
}

/**
 * Where a line's runs begin, without decoding the line.
 *
 * The same arithmetic `readSpeechRuns` does before it walks anything, pulled
 * out because a **rewrite** wants only this: the bytes before it are the
 * line's own header and are copied through, and the bytes after it are thrown
 * away and written again. Decoding 43.9 MB of audio to learn where forty-four
 * bytes end would be the alternative.
 *
 * Throws for bytes that are not a speech line, the way the reader does — a
 * header this cannot find is a line this must not rewrite.
 */
export function speechRunsAt(bytes: Uint8Array, mode: Sword1SpeechMode = 'wave'): number {
  // The retail container states the uncompressed length in a word of its own
  // after the tag; the demo's states it *inside* the run stream, so its runs
  // start at the tag and the stated length decodes as the first two samples.
  return speechDataTag(bytes) + (mode === 'wave' ? 8 : 4);
}

/**
 * Takes a speech stream apart into its runs, without truncating it.
 *
 * `expandSpeech` is this plus the container's stated length; the encoder wants
 * the runs themselves, because a stream is only re-encodable byte-identically
 * from everything it holds.
 */
export function readSpeechRuns(
  bytes: Uint8Array,
  bigEndian = false,
  mode: Sword1SpeechMode = 'wave',
): Sword1SpeechStream {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = speechDataTag(bytes) + 4;
  const limit = bytes.length >> 1;

  // The uncompressed size, in bytes, then halved: the stream is 16-bit samples.
  // Where it is read from is the whole of the difference between the two
  // containers, and in the demo's it is sometimes not stated at all — the else
  // branch below walks the runs and adds up what they will produce, which is
  // what the original does for the same files (`sound.cpp:647`).
  let declared: number;
  if (mode === 'wave') {
    declared = view.getUint32(at, true) >>> 1;
    at += 4;
  } else if (bytes[at + 1] === 0) {
    declared =
      view.getUint16(at, true) === 1
        ? view.getUint16(at + 2, true) | (view.getUint16(at + 6, true) << 16)
        : view.getUint32(at + 2, true);
    declared >>>= 1;
  } else {
    declared = 0;
    for (let scan = at >> 1; scan < limit;) {
      // Little-endian whichever way the samples are stored: this is counting
      // runs, and a Macintosh release's byte order applies to the *samples*.
      const run = view.getInt16(scan * 2, true);
      scan++;
      if (run < 0) {
        declared -= run;
        scan++;
      } else {
        declared += run;
        scan += run;
      }
    }
  }

  if (declared > MAX_SPEECH_SAMPLES) {
    throw new SwordAudioError(
      `This speech line declares ${declared} samples, which is longer than ten minutes — ` +
        `so the bytes are not ${mode === 'demo' ? 'the demo' : 'a retail'} container's speech.`,
    );
  }

  const runsAt = at;
  const word = (position: number): number =>
    bigEndian ? view.getInt16(position * 2, false) : view.getInt16(position * 2, true);

  // Counted before it is filled, because what the runs produce is not what the
  // container says and an array that grows by doubling would be the only other
  // way to find out.
  let produced = 0;
  for (let scan = runsAt >> 1; scan < limit;) {
    const run = view.getInt16(scan * 2, true);
    scan++;
    if (run < 0) {
      produced -= run;
      scan++;
    } else {
      produced += run;
      scan += run;
    }
    if (produced > MAX_SPEECH_SAMPLES) {
      throw new SwordAudioError(
        `This speech line's runs produce more than ten minutes of audio, so the bytes are not ` +
          `${mode === 'demo' ? 'the demo' : 'a retail'} container's speech.`,
      );
    }
  }

  const samples = new Int16Array(produced);
  let dstPos = 0;
  for (let srcPos = runsAt >> 1; srcPos < limit;) {
    const length = view.getInt16(srcPos * 2, true);
    srcPos++;
    if (length < 0) {
      const value = word(srcPos);
      for (let count = 0; count < -length && dstPos < produced; count++) samples[dstPos++] = value;
      srcPos++;
    } else {
      for (let count = 0; count < length && dstPos < produced; count++) {
        samples[dstPos++] = word(srcPos++);
      }
    }
  }

  return { runsAt, samples, declared };
}

/**
 * Expands Broken Sword's compressed speech into 16-bit samples.
 *
 * `bigEndian` is for the Macintosh releases, some of which store the speech
 * words big-endian *while sharing the container format*. ScummVM detects it by
 * decoding a sample both ways and seeing which one stays in bounds; that
 * detection is `checkSpeechEndianness` below, and it exists because the files
 * carry no flag.
 */
export function expandSpeech(
  bytes: Uint8Array,
  bigEndian = false,
  mode: Sword1SpeechMode = 'wave',
): Int16Array {
  const stream = readSpeechRuns(bytes, bigEndian, mode);
  // A short stream leaves silence rather than stale samples, which is what the
  // original does and is audibly better than a click; a long one is cut at the
  // length the container states, which is what the original's `samplesLeft`
  // does one run at a time.
  const out = new Int16Array(stream.declared);
  out.set(stream.samples.subarray(0, Math.min(stream.samples.length, out.length)));

  // The demo's first two samples are the length that was embedded in the
  // stream, decoded as though they were audio. The original zeroes them
  // (`sound.cpp:713`) and so does this: left alone they are a click at the
  // start of every line.
  if (mode === 'demo') {
    if (out.length > 0) out[0] = 0;
    if (out.length > 1) out[1] = 0;
  }
  return out;
}

/**
 * Guesses the speech stream's byte order by decoding it both ways.
 *
 * The correct order decodes to exactly the declared length with every run in
 * bounds; the wrong one runs out early or asks for more than the file holds.
 * ScummVM's own approach, and it is a guess with a check rather than a guess.
 */
export function checkSpeechEndianness(bytes: Uint8Array, mode: Sword1SpeechMode = 'wave'): boolean {
  for (const bigEndian of [false, true]) {
    try {
      const decoded = expandSpeech(bytes, bigEndian, mode);
      // A stream whose last quarter is all zeroes decoded short, which is what
      // the wrong byte order looks like.
      const tail = decoded.subarray(Math.floor((decoded.length * 3) / 4));
      if (tail.some((sample) => sample !== 0)) return bigEndian;
    } catch {
      continue;
    }
  }
  return false;
}

/** A decoded speech line as a playable sample. Speech is 11.025 kHz mono. */
export function speechSample(
  bytes: Uint8Array,
  bigEndian = false,
  mode: Sword1SpeechMode = 'wave',
): SwordSample {
  const samples = expandSpeech(bytes, bigEndian, mode);
  const data = new Float32Array(samples.length);
  for (let at = 0; at < samples.length; at++) data[at] = samples[at] / 32768;
  return { sampleRate: 11025, channels: 1, data, frames: samples.length };
}

/**
 * Writes Broken Sword's speech compression: the other half of `expandSpeech`.
 *
 * The scheme leaves no room for choice once one thing is measured, which is
 * what makes a byte-identical re-encode possible rather than lucky. Across all
 * 808 lines in the demo's `COWS.MAD`, **no literal run contains two adjacent
 * identical samples** and **no repeat run is shorter than two**, so the rule
 * the original encoder used is the greedy one: a sample equal to the next one
 * begins a repeat that runs as long as the samples stay equal, and everything
 * else accumulates into a literal that ends where the next repeat begins.
 *
 * The one bound that is this reader's rather than the data's is 32,767: a run
 * count is a signed 16-bit word, and a longer stretch of silence than that
 * simply becomes two runs. The demo's longest shipped repeat is 1,998.
 *
 * `bigEndian` is the Macintosh releases' sample order, and it applies to the
 * *samples* only — the run counts are little-endian either way, exactly as
 * `expandSpeech` reads them.
 *
 * ## What the demo measures, including the nine that do not match
 *
 * `npm run sweep:sword` re-encodes every line of a real install and counts:
 * **799 of the demo's 808** come back as the bytes Revolution shipped. The
 * other nine differ in their last run only, and all nine decode to exactly the
 * samples they were made from — the sweep calls them ties for that reason.
 *
 * They are ties the shipped data cannot resolve, not a rule this misses. A
 * single sample left at the end of a stream costs two words either way, as a
 * literal of one or as a repeat of one, and `COWS.MAD` contains **both**: 64
 * lines end `1, x` and three end `-1, x` in the identical situation. The other
 * six end a literal one sample early and then spend the extra word. Following
 * either convention therefore breaks the other, and this follows the 64 —
 * choosing the shorter output where the two disagree on length.
 */
export function compressSpeech(samples: Int16Array, bigEndian = false): Uint8Array {
  /** A run count is a signed 16-bit word, so this is what one can say. */
  const MAX_RUN = 32767;

  const runs: Array<{ count: number; from: number }> = [];
  let at = 0;
  let length = 0;
  while (at < samples.length) {
    let repeat = 1;
    while (
      at + repeat < samples.length &&
      samples[at + repeat] === samples[at] &&
      repeat < MAX_RUN
    ) {
      repeat++;
    }
    if (repeat >= 2) {
      runs.push({ count: -repeat, from: at });
      at += repeat;
      length += 2;
      continue;
    }
    // A literal runs until the next pair of equal samples, which is where the
    // encoder that made these files stopped every one of them. A lone sample
    // left at the very end comes out as a literal of one, which is what 64 of
    // the demo's 67 streams that end that way do; the other three write the
    // same sample as a repeat of one, and `compressSpeech` follows the 64.
    let literal = 1;
    while (
      at + literal < samples.length &&
      literal < MAX_RUN &&
      !(at + literal + 1 < samples.length && samples[at + literal + 1] === samples[at + literal])
    ) {
      literal++;
    }
    runs.push({ count: literal, from: at });
    at += literal;
    length += 1 + literal;
  }

  const out = new Uint8Array(length * 2);
  const view = new DataView(out.buffer);
  let cursor = 0;
  for (const run of runs) {
    view.setInt16(cursor * 2, run.count, true);
    cursor++;
    const count = run.count < 0 ? 1 : run.count;
    for (let index = 0; index < count; index++) {
      view.setInt16(cursor * 2, samples[run.from + index], !bigEndian);
      cursor++;
    }
  }
  return out;
}
