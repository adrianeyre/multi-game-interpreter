import { readTag, readU32BE } from '../util/ByteStream.js';
import { decodeVoc, type DecodedPcm } from './SoundEngine.js';

/**
 * Recorded speech, out of a talkie release's external speech file.
 *
 * A talkie release does not keep its speech in the indexed sound resources: it
 * keeps it in one large `MONSTER.SOU` beside the game files, and a script names
 * a line of dialogue by its **byte offset** into that file. So there is no
 * directory to read and nothing to enumerate — a sample is only ever found by
 * being asked for.
 *
 * Layout at that offset, per ScummVM's `startTalkSound`:
 *
 *     VCTL <size>            8 byte header
 *     <sync times>           (size - 8) / 2 big-endian 16-bit values
 *     Crea / VTLK ...        the audio, as a VOC
 *
 * The sync times are mouth-animation cues rather than audio, and the size in
 * the `VCTL` header is what a script passes as the sample's "length" — it is
 * the size of that header block, **not** the duration of the speech. Reading it
 * as a duration is the obvious mistake and produces speech that is cut off or
 * padded on every line.
 *
 * Why this matters beyond the audio: v6 scripts wait for speech to finish. A
 * wait fed the wrong duration either races past unreadably or never returns, so
 * the sample's real length is load-bearing even for a player with sound off.
 */

export interface SpeechSample {
  pcm: DecodedPcm;
  /** Mouth-animation cues, in the units the sync stream uses. */
  syncTimes: number[];
  /** How long the speech runs, in seconds. What a speech-wait must last. */
  duration: number;
}

/**
 * Reads one sample, or null when the offset does not hold one.
 *
 * Null rather than throwing, and for a reason: a release can be repackaged,
 * truncated by a bad copy, or compressed into a format this does not read, and
 * none of those should stop the game. A line without its audio is a line with
 * subtitles; a thrown error mid-cutscene is a broken game.
 */
export function readSpeechSample(
  sou: Uint8Array,
  offset: number,
  vctlSize: number,
): SpeechSample | null {
  if (offset < 0 || offset + 8 > sou.length) return null;
  if (readTag(sou, offset) !== 'VCTL') return null;

  // The script's size and the file's own agree in a healthy release. Where they
  // do not, the file wins: it is the thing being read.
  const blockSize = readU32BE(sou, offset + 4);
  const headerSize = blockSize >= 8 && offset + blockSize <= sou.length ? blockSize : vctlSize;
  if (headerSize < 8 || offset + headerSize > sou.length) return null;

  const syncTimes: number[] = [];
  for (let at = offset + 8; at + 1 < offset + headerSize; at += 2) {
    const value = (sou[at] << 8) | sou[at + 1];
    if (value === 0xffff) break;
    syncTimes.push(value);
  }

  const audioAt = offset + headerSize;
  if (audioAt + 8 > sou.length) return null;

  const tag = readTag(sou, audioAt);

  // Only one of the two is a chunk. `VTLK` is: four bytes of tag, four of size
  // — the whole block including that header — and then the VOC. `Crea` is not a
  // tag at all, it is the first four characters of `Creative Voice File`, so the
  // VOC begins exactly where it was found and there is no size beside it; the
  // VOC's own block headers say how long it runs, which is what `decodeVoc`
  // reads, so handing it the rest of the file is safe.
  //
  // This was wrong until Full Throttle's `MONSTER.SOU` was read: both offsets
  // were eight bytes too far, on the assumption that `Crea` had a chunk header
  // like everything else in a SCUMM file. The synthetic fixture was written to
  // match the assumption rather than a real release, so it agreed. The symptom
  // was every line of speech reading as "no speech here" — the quiet failure
  // this reader is designed to produce, and the reason it went unnoticed.
  let vocAt: number;
  let end: number;
  if (tag === 'Crea') {
    vocAt = audioAt;
    end = sou.length;
  } else if (tag === 'VTLK') {
    const size = readU32BE(sou, audioAt + 4);
    vocAt = audioAt + 8;
    end = size > 8 ? Math.min(sou.length, audioAt + size) : sou.length;
  } else {
    return null;
  }
  if (vocAt >= end) return null;

  const pcm = decodeVoc(sou.subarray(vocAt, end));
  if (!pcm || pcm.samples.length === 0) return null;

  return { pcm, syncTimes, duration: pcm.samples.length / pcm.sampleRate };
}

/**
 * How long a line should stay up when there is no recorded speech.
 *
 * The floppy releases had no speech and timed their text by its length, which
 * is what makes a non-talkie release pace correctly. `charInc` is the
 * per-character delay the game itself sets, so a game that wants slower text
 * gets it.
 *
 * In frames, because that is what the message timer counts.
 */
export function textDurationFrames(text: string, charInc: number): number {
  return Math.max(30, text.length * Math.max(1, charInc || 4));
}

/** Seconds of audio as a whole number of frames, for the message timer. */
export function speechDurationFrames(seconds: number, framesPerSecond = 60): number {
  return Math.max(1, Math.round(seconds * framesPerSecond));
}
