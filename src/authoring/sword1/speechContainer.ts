/**
 * Rebuilding Broken Sword's speech container, so a replaced line survives.
 *
 * `compressSpeech` writes Revolution's 16-bit RLE back and `npm run
 * sweep:sword` counts 799 of the demo's 808 lines re-encoding to the bytes
 * that shipped — but an encoder with nothing to write into is a measurement
 * rather than a capability. Speech is the one thing this family keeps outside
 * `swordres.rif`: `SPEECH/COWS.MAD` in the demo, `SPEECH1.CLU` on a retail
 * disc, each with an index of its own at the front. `exportSword1Game` rebuilt
 * the clusters and the index and left the container alone, so an author who
 * replaced a line heard it in the editor and never in the game.
 *
 * This is the rebuild, and it follows the same sentence every other layout
 * here does — copy what was not touched, substitute what was, rebuild the
 * index:
 *
 * 1. The index is copied whole and then patched: only the offset and length
 *    words of lines that actually moved are written, so the room table, the
 *    zero-length entries a release never recorded, and the one-word overlap
 *    between neighbouring rooms' blocks all come through untouched.
 * 2. The payloads are laid out in the order the container already had them,
 *    with the bytes *between* them copied verbatim. A container with no gaps
 *    — which the demo's is, 808 payloads running end to end from byte 18,928
 *    to the last byte of the file — comes back byte-identical when nothing was
 *    replaced, and that is what makes a diff of an export the author's changes.
 *
 * ## Writing a line the demo's container will read back
 *
 * The two containers differ in one place and it is the place that matters
 * here. A retail line states its uncompressed length in a word of its own
 * after the `data` tag. **The demo's states it inside the run stream**: the
 * runs begin at the tag, and the first two samples they decode to *are* the
 * stated length, which is why `expandSpeech` zeroes them.
 *
 * So a freshly compressed line cannot simply be dropped in behind the old
 * header — the length would be gone, and `readSpeechRuns` decides how to find
 * it by looking at the high byte of the first run count. The replacement is
 * therefore built as `[lo, hi, ...audio]` and compressed as a whole, with `lo`
 * and `hi` holding the byte length the way the shipped lines hold it. That is
 * correct down every branch the reader can take, which is the argument for
 * doing it this way rather than the hope:
 *
 * - First run a **literal of 2 or more** (count's high byte 0, count ≠ 1): the
 *   reader takes `u32` at `runs + 2`, which is `lo` then `hi` — the length.
 * - First run a **literal of 1**: the reader takes `u16` at `runs + 2` and
 *   `u16` at `runs + 6`. A run's data always follows its count, so those are
 *   samples 0 and 1 whatever the second run is — `lo` and `hi` again.
 * - First run a **repeat** (count negative, high byte ≥ 0x80) or a **literal
 *   of 256 or more** (high byte non-zero): the reader walks the runs and adds
 *   up what they produce, which is exactly the sample count `lo`/`hi` state.
 *
 * The shipped lines confirm the reading rather than the reasoning confirming
 * itself: room 0 line 1 begins `12, -6514, 1, …` and states 124,558 bytes,
 * which is `(-6514 & 0xffff) | (1 << 16)`.
 *
 * ## What it refuses
 *
 * A replacement for a line the release never recorded is refused rather than
 * appended. Adding a recording means giving a zero-length index entry an
 * offset and a length, which invents a recording where the game has none —
 * and it is a different thing from appending a compact or an object (§12a),
 * which both add a record at the end of a table without moving a payload any
 * index measures in bytes. A container whose payloads overlap is refused too,
 * because laying it out again would move bytes this reader cannot account
 * for.
 */

import {
  parseSword1SpeechIndex,
  type Sword1SpeechEntry,
  type Sword1SpeechIndex,
} from '../../engine/sword1/sound/speechIndex.js';
import {
  compressSpeech,
  speechRunsAt,
  SwordAudioError,
  type Sword1SpeechMode,
} from '../../engine/sword1/sound/swordAudio.js';
import { readWavePcm, resampleWavePcm } from '../../engine/sound/wave.js';

/** Raised when a container cannot be rebuilt, with what was wrong. */
export class Sword1SpeechError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Sword1SpeechError';
  }
}

/** Speech is 11,025 Hz mono in every release, and the engine states the rate. */
const SPEECH_RATE = 11025;

/** The bound `readSpeechRuns` applies, so a rebuild refuses what it would. */
const MAX_SPEECH_SAMPLES = SPEECH_RATE * 600;

/** One line an author replaced: which line, and the file they dropped in. */
export interface Sword1SpeechReplacement {
  /** The screen the line belongs to — `bank` on the track's resource. */
  readonly room: number;
  readonly line: number;
  /** The bytes as the author supplied them: a PCM WAVE. */
  readonly wav: Uint8Array;
}

/** What a rebuild did, so an export can report it rather than guess. */
export interface Sword1SpeechRebuild {
  readonly data: Uint8Array;
  /** Lines whose audio this rebuild changed, named the way the editor names them. */
  readonly replaced: readonly string[];
  /** Lines carried through as the bytes they arrived as. */
  readonly copied: number;
}

/**
 * Which of the two containers this is, from its name.
 *
 * The same rule `SwordSound` and `sword1AudioReader` use, and for the same
 * evidence — the original sets `CowDemo` exactly when it opened `cows.mad`
 * (`sound.cpp:784`).
 */
export function sword1SpeechMode(file: string): Sword1SpeechMode {
  return /(?:^|[/\\])cows\.mad$/i.test(file) ? 'demo' : 'wave';
}

/** How a line is named in a message, matching the editor's own rows. */
function nameOf(room: number, line: number): string {
  return `screen ${room} line ${line}`;
}

/**
 * The samples a replacement file holds, at the rate the game plays them.
 *
 * Refuses rather than guesses when the bytes are not a PCM WAVE, because the
 * editor's Replace button accepts anything a browser can play and only this
 * family needs the samples themselves — an MP3 dropped on a speech row is a
 * thing to say, not a thing to write silence for.
 */
export function sword1SpeechSamples(wav: Uint8Array, what: string): Int16Array {
  const pcm = readWavePcm(wav);
  if (!pcm) {
    throw new Sword1SpeechError(
      `The replacement for ${what} is not a PCM WAVE. Broken Sword's container holds ` +
        `Revolution's own 16-bit compression, so this has to re-encode the samples themselves ` +
        `rather than copy a file in — save the replacement as a WAV and it will be written.`,
    );
  }
  const samples = resampleWavePcm(pcm.samples, pcm.sampleRate, SPEECH_RATE);
  if (samples.length + 2 > MAX_SPEECH_SAMPLES) {
    throw new Sword1SpeechError(
      `The replacement for ${what} is ${(samples.length / SPEECH_RATE).toFixed(0)} seconds of ` +
        `audio, and a speech line's length is read back as a 32-bit count that this reader caps ` +
        `at ten minutes. It is refused rather than written as a length nothing will believe.`,
    );
  }
  return samples;
}

/**
 * One line's bytes, as the container holds them: its own header, then runs.
 *
 * The header is the line's, copied verbatim and then corrected — not a header
 * this invents. Two fields in it count the *uncompressed* audio and both are
 * rewritten to describe the new samples: `RIFF`'s size, which the shipped
 * lines hold as the tag's offset plus the stated byte length, and (retail
 * only) the word after the `data` tag.
 */
export function writeSword1SpeechLine(
  original: Uint8Array,
  samples: Int16Array,
  mode: Sword1SpeechMode,
  bigEndian: boolean,
): Uint8Array {
  const runsAt = speechRunsAt(original, mode);
  const tagAt = runsAt - (mode === 'wave' ? 8 : 4);

  // The demo carries its length as the stream's first two samples, so they are
  // part of what gets compressed; a retail line's length has a word of its own
  // and the samples are the audio alone.
  const stated = (mode === 'demo' ? samples.length + 2 : samples.length) * 2;
  const full =
    mode === 'demo'
      ? (() => {
          const built = new Int16Array(samples.length + 2);
          built[0] = stated & 0xffff;
          built[1] = stated >>> 16;
          built.set(samples, 2);
          return built;
        })()
      : samples;

  const runs = compressSpeech(full, bigEndian);
  const out = new Uint8Array(runsAt + runs.length);
  out.set(original.subarray(0, runsAt), 0);
  out.set(runs, runsAt);

  const view = new DataView(out.buffer);
  // Only where the header really is a RIFF: a release that wrapped its runs in
  // something else would have some other field at byte 4, and writing a length
  // over it would be this exporter inventing a header again.
  if (String.fromCharCode(out[0]!, out[1]!, out[2]!, out[3]!) === 'RIFF') {
    view.setUint32(4, tagAt + stated, true);
  }
  if (mode === 'wave') view.setUint32(tagAt + 4, stated, true);
  return out;
}

/** Every line the index names, grouped by the offset they are stored at. */
function payloads(
  file: string,
  index: Sword1SpeechIndex,
): Array<{ at: number; length: number; lines: Sword1SpeechEntry[] }> {
  const byOffset = new Map<number, { at: number; length: number; lines: Sword1SpeechEntry[] }>();
  for (const entry of index.entries()) {
    // Two entries at one offset are one recording the release points at twice,
    // which is a thing these containers do. They share a payload here as they
    // do in the file, so replacing either replaces what both play — which is
    // what sharing a recording means.
    const found = byOffset.get(entry.at);
    if (!found) {
      byOffset.set(entry.at, { at: entry.at, length: entry.length, lines: [entry] });
      continue;
    }
    // Unless they disagree about how long it is. Two entries at one offset with
    // two lengths is one of them pointing at a *prefix* of the other, and this
    // writes one payload per offset — so it would have to give both the same
    // length and would silently lengthen or truncate whichever it lost. The
    // demo's container has no such pair (808 entries at 808 distinct offsets),
    // and a release that had one is refused rather than quietly rewritten.
    if (found.length !== entry.length) {
      throw new Sword1SpeechError(
        `${file} names ${nameOf(found.lines[0]!.room, found.lines[0]!.line)} and ` +
          `${nameOf(entry.room, entry.line)} at the same byte, ${entry.at}, with two different ` +
          `lengths (${found.length} and ${entry.length}). One of them is a prefix of the other, ` +
          `and rebuilding the container would have to give both a single length — so it is ` +
          `refused rather than written with one of the two silently changed.`,
      );
    }
    found.lines.push(entry);
  }
  return [...byOffset.values()].sort((left, right) => left.at - right.at);
}

/**
 * Writes a speech container back, with the lines an author replaced in it.
 *
 * With no replacements this is a copy — which is the property worth having,
 * because it is what lets `npm run reexport:sword` diff an unmodified export
 * against the install it came from and get silence.
 */
export function rebuildSword1Speech(
  file: string,
  container: Uint8Array,
  replacements: readonly Sword1SpeechReplacement[] = [],
  options: { bigEndian?: boolean } = {},
): Sword1SpeechRebuild {
  const index = parseSword1SpeechIndex(file, container);
  if (!index) {
    throw new Sword1SpeechError(
      `${file} does not begin with a speech index, so there is nothing to rebuild against. ` +
        `Broken Sword's speech container starts with the length of its own index, and this ` +
        `file's first four bytes are not one.`,
    );
  }

  const mode = sword1SpeechMode(file);
  const bigEndian = options.bigEndian ?? false;

  // Every replacement resolved to samples before a byte is laid out, for the
  // reason `editedResources` builds its map first: a line's *length* decides
  // where everything after it goes, so a refusal has to happen before the file
  // is half written rather than in the middle of it.
  const wanted = new Map<number, { name: string; samples: Int16Array }>();
  for (const replacement of replacements) {
    const name = nameOf(replacement.room, replacement.line);
    const entry = index.locate(replacement.room, replacement.line);
    if (!entry) {
      throw new Sword1SpeechError(
        `${file} has no recording for ${name}, so a replacement for it has nowhere to go. ` +
          `Giving it one means adding a record to the container's index, which this project ` +
          `does not do for either Broken Sword — the surface says so rather than writing an ` +
          `entry the game would read as a line it never had.`,
      );
    }
    wanted.set(entry.at, { name, samples: sword1SpeechSamples(replacement.wav, name) });
  }

  // The index, copied whole and patched in place. Word `n` of the index sits
  // at byte `4 + n * 4`, because the first four bytes are the index's own
  // length rather than its first word.
  const words = new Uint8Array(index.indexBytes);
  words.set(container.subarray(0, index.indexBytes));
  const wordView = new DataView(words.buffer);
  const wordAt = (word: number): number => 4 + word * 4;
  const parts: Uint8Array[] = [words];

  const replaced: string[] = [];
  let copied = 0;
  let read = index.indexBytes;
  let write = index.indexBytes;

  for (const payload of payloads(file, index)) {
    if (payload.at < read) {
      throw new Sword1SpeechError(
        `${file} stores ${nameOf(payload.lines[0]!.room, payload.lines[0]!.line)} at byte ` +
          `${payload.at}, which is inside the recording before it. Laying the container out ` +
          `again would move bytes this reader cannot account for, so it is refused.`,
      );
    }
    // Whatever sits between two recordings is copied rather than dropped. The
    // demo's container has none of it — 808 payloads end to end — but a
    // release that padded would otherwise come back shorter than it went in,
    // and "byte-identical when nothing changed" is the whole point.
    if (payload.at > read) {
      parts.push(container.subarray(read, payload.at));
      write += payload.at - read;
    }

    const original = container.subarray(payload.at, payload.at + payload.length);
    const wants = wanted.get(payload.at);
    let bytes = original;
    if (wants) {
      try {
        bytes = writeSword1SpeechLine(original, wants.samples, mode, bigEndian);
      } catch (error) {
        if (error instanceof SwordAudioError) {
          throw new Sword1SpeechError(
            `${wants.name} could not be replaced: this reader cannot find where its runs begin ` +
              `in the bytes ${file} holds (${error.message}), and a line whose header it cannot ` +
              `read is a line it must not write over.`,
          );
        }
        throw error;
      }
      replaced.push(wants.name);
    } else {
      copied++;
    }
    parts.push(bytes);

    // Both words of every entry that names this payload, whether it moved or
    // not: an offset the layout did not change is written back as itself.
    for (const line of payload.lines) {
      wordView.setUint32(wordAt(line.lengthAt), bytes.length, true);
      wordView.setUint32(wordAt(line.lengthAt - 1), write - index.indexBytes, true);
    }
    write += bytes.length;
    read = payload.at + payload.length;
  }

  // And the tail, for the same reason as the gaps.
  if (read < container.length) parts.push(container.subarray(read));

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const data = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    data.set(part, at);
    at += part.length;
  }
  return { data, replaced, copied };
}
