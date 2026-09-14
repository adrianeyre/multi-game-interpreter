/**
 * Rebuilding Broken Sword II's speech and music containers around a replacement.
 *
 * The same sentence as everywhere else in this project — copy what was not
 * touched, substitute what was, rebuild the index — against the one layout in
 * this family that is not a resource. `sword2Clu.ts` says what the layout is
 * and why it cannot be a cluster; this is the write half.
 *
 * ## Written here, unproven here, and the difference matters
 *
 * **No install reachable from this repository ships one of these containers.**
 * `/home/agent/games/sword2` is the DOS demo: `resource.inf` names fourteen
 * clusters, not one of them is `speech1.clu` or `music1.clu`, and the folder
 * itself holds five `.clu` files, all of them ordinary resource clusters. So
 * every byte of this file is written against ScummVM's reader rather than
 * against a container, and that is stated on the surface (the Audio section
 * says it on a speech row) as well as in `docs/editor-parity.md` §27a.
 *
 * What _is_ measured is the codec, which is the part a container would not
 * have told us anyway: `encodeSword2Clu` then `decodeSword2Clu` over real
 * recordings out of both demos, reported as a sample difference. What is not
 * measured is that a retail `SPEECH1.CLU` reads back what this writes. The
 * honest description is "written, not verified", and it must not be read as
 * anything else.
 *
 * ## What it refuses
 *
 * A replacement for an id the release never recorded: the index's slot is
 * there but its offset and length are zero, and giving it both would be
 * inventing a recording where the game has none. That is the same refusal
 * `rebuildSword1Speech` makes, and it is about *this* layout rather than about
 * appending in general — a compact and a Sword II object can both be appended
 * now (§12a), and neither of those moves a payload the index measures in
 * bytes.
 *
 * A container whose payloads overlap is refused too, for the reason Sword 1's
 * is: laying it out again would move bytes this reader cannot account for.
 */

import {
  decodeSword2Clu,
  encodeSword2Clu,
  parseSword2CluIndex,
  SWORD2_CLU_RATE,
  type Sword2CluEntry,
  type Sword2CluIndex,
} from '../../engine/sword2/sound/sword2Clu.js';
import { readWavePcm, resampleWavePcm } from '../../engine/sound/wave.js';

/** Raised when a container cannot be rebuilt, with what was wrong. */
export class Sword2SoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Sword2SoundError';
  }
}

/** Ten minutes, as a bound on what an author can drop on one row. */
const MAX_SAMPLES = SWORD2_CLU_RATE * 600;

/** One recording an author replaced: which entry, and the file they dropped in. */
export interface Sword2SoundReplacement {
  /** Its index in the container, which is the id a script plays it by. */
  readonly index: number;
  /** The bytes as the author supplied them: a PCM WAVE. */
  readonly wav: Uint8Array;
}

/** What a rebuild did, so an export can report it rather than guess. */
export interface Sword2SoundRebuild {
  readonly data: Uint8Array;
  /** Entries whose audio this rebuild changed, named as the editor names them. */
  readonly replaced: readonly string[];
  /** Recordings carried through as the bytes they arrived as. */
  readonly copied: number;
}

/** How an entry is named in a message. */
function nameOf(file: string, index: number): string {
  return `${file} entry ${index}`;
}

/**
 * The samples a replacement file holds, at the rate the container is played at.
 *
 * Refuses rather than guesses when the bytes are not a PCM WAVE, for the
 * reason `sword1SpeechSamples` does: this container holds a codec of
 * Revolution's own, so the samples themselves are what gets written and an
 * MP3 dropped on a row is a thing to say rather than a thing to encode
 * silence for.
 */
export function sword2SoundSamples(wav: Uint8Array, what: string): Int16Array {
  const pcm = readWavePcm(wav);
  if (!pcm) {
    throw new Sword2SoundError(
      `The replacement for ${what} is not a PCM WAVE. Broken Sword II's speech and music live ` +
        `in a container that holds one byte per sample of Revolution's own delta compression, ` +
        `so this has to re-encode the samples rather than copy a file in — save the replacement ` +
        `as a WAV and it will be written.`,
    );
  }
  const samples = resampleWavePcm(pcm.samples, pcm.sampleRate, SWORD2_CLU_RATE);
  if (samples.length === 0) {
    throw new Sword2SoundError(
      `The replacement for ${what} holds no samples, and an entry with no samples is one the ` +
        `engine reads as a recording the release never made.`,
    );
  }
  if (samples.length > MAX_SAMPLES) {
    throw new Sword2SoundError(
      `The replacement for ${what} is ${(samples.length / SWORD2_CLU_RATE).toFixed(0)} seconds ` +
        `of audio at ${SWORD2_CLU_RATE} Hz, which is past the ten minutes this writer will put ` +
        `in a container. It is refused rather than written as an entry nothing will stream.`,
    );
  }
  return samples;
}

/** Every recording the index names, grouped by the offset they are stored at. */
function payloads(
  index: Sword2CluIndex,
): Array<{ at: number; length: number; entries: Sword2CluEntry[] }> {
  const byOffset = new Map<number, { at: number; length: number; entries: Sword2CluEntry[] }>();
  for (const entry of index.entries()) {
    const found = byOffset.get(entry.at);
    if (!found) {
      byOffset.set(entry.at, { at: entry.at, length: entry.length, entries: [entry] });
      continue;
    }
    // Two ids at one offset are one recording the release points at twice, and
    // they share a payload here as they do in the file. Two lengths at one
    // offset is one of them naming a prefix of the other, which this layout
    // cannot express once the payload has been rewritten — refused by name
    // rather than silently given a single length.
    if (found.length !== entry.length) {
      throw new Sword2SoundError(
        `${index.file} names entry ${found.entries[0]!.index} and entry ${entry.index} at the ` +
          `same byte, ${entry.at}, with two different lengths (${found.length} and ` +
          `${entry.length}). One is a prefix of the other, and rebuilding the container would ` +
          `have to give both a single length — so it is refused rather than written with one of ` +
          `the two silently changed.`,
      );
    }
    found.entries.push(entry);
  }
  return [...byOffset.values()].sort((left, right) => left.at - right.at);
}

/**
 * Writes a container back, with the recordings an author replaced in it.
 *
 * With no replacements this is a copy, which is the property worth having for
 * the same reason it is in Sword 1: it is what would let a re-export of an
 * untouched install come back byte-identical, so that a diff is the author's
 * changes. Nothing here can run that check against a real container, and the
 * test that stands in for it builds one with this project's own writer — which
 * proves the layout is self-consistent and proves nothing about Revolution's.
 */
export function rebuildSword2Sound(
  file: string,
  container: Uint8Array,
  replacements: readonly Sword2SoundReplacement[] = [],
): Sword2SoundRebuild {
  const index = parseSword2CluIndex(file, container);
  if (!index) {
    throw new Sword2SoundError(
      `${file} does not begin with a Broken Sword II sound index, so there is nothing to ` +
        `rebuild against. One of these containers starts with the number of entries it holds ` +
        `and then a table of byte offsets and lengths, and this file's do not describe it.`,
    );
  }

  // Every replacement resolved to samples before a byte is laid out, for the
  // reason the Sword 1 rebuild does it: a recording's length decides where
  // everything after it goes, so a refusal has to happen before the file is
  // half written.
  const wanted = new Map<number, { name: string; payload: Uint8Array }>();
  for (const replacement of replacements) {
    const name = nameOf(file, replacement.index);
    const entry = index.locate(replacement.index);
    if (!entry) {
      throw new Sword2SoundError(
        `${file} holds no recording under ${replacement.index}, so a replacement for it has ` +
          `nowhere to go. Its slot in the index states an offset and a length of zero, which is ` +
          `how this format says a release recorded nothing — writing one would be inventing a ` +
          `recording rather than replacing it, so it is refused.`,
      );
    }
    wanted.set(entry.at, {
      name,
      payload: encodeSword2Clu(sword2SoundSamples(replacement.wav, name)),
    });
  }

  // The index, copied whole and then patched: every entry's two words are
  // written back, an entry that did not move written back as itself, and the
  // zero-length slots the release never recorded left exactly as they are.
  const words = new Uint8Array(index.indexBytes);
  words.set(container.subarray(0, index.indexBytes));
  const wordView = new DataView(words.buffer);
  const parts: Uint8Array[] = [words];

  const replaced: string[] = [];
  let copied = 0;
  let read = index.indexBytes;
  let write = index.indexBytes;

  for (const payload of payloads(index)) {
    if (payload.at < read) {
      throw new Sword2SoundError(
        `${file} stores entry ${payload.entries[0]!.index} at byte ${payload.at}, which is ` +
          `inside the recording before it. Laying the container out again would move bytes this ` +
          `reader cannot account for, so it is refused.`,
      );
    }
    // Whatever sits between two recordings is copied rather than dropped, so a
    // container that padded comes back the length it went in at.
    if (payload.at > read) {
      parts.push(container.subarray(read, payload.at));
      write += payload.at - read;
    }

    const wants = wanted.get(payload.at);
    const bytes = wants
      ? wants.payload
      : container.subarray(payload.at, payload.at + payload.length);
    if (wants) replaced.push(wants.name);
    else copied++;
    parts.push(bytes);

    for (const entry of payload.entries) {
      wordView.setUint32(8 + entry.index * 8, write, true);
      wordView.setUint32(8 + entry.index * 8 + 4, bytes.length, true);
    }
    write += bytes.length;
    read = payload.at + payload.length;
  }

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

/**
 * One recording out of a container, as a PCM WAVE the editor can play.
 *
 * The read half, here rather than in the editor because the decode and the
 * rate belong together: a caller that had to know both would be a second place
 * this format is described.
 */
export function readSword2Sound(container: Uint8Array, entry: Sword2CluEntry): Int16Array {
  return decodeSword2Clu(container.subarray(entry.at, entry.at + entry.length));
}
