/**
 * Digital audio: `RESOURCE.AUD` and `RESOURCE.SFX`, addressed by offset.
 *
 * Straight Talkie precedent (#221). SCUMM's `MONSTER.SOU` is one file a script
 * indexes into by byte offset, and SCI's is the same shape with a table in
 * front of it — so it is read through `VolumeReader` a sample at a time rather
 * than buffered, which is ADR 0021's whole point and matters more here because
 * a SCI2.1 release's speech is hundreds of megabytes.
 *
 * **The table is a `map` resource, and there are two kinds.** A game with one
 * language and no per-room speech has a single map numbered 65535, listing
 * plain resource numbers; a game with speech keyed to dialogue has one map per
 * room, listing the (noun, verb, condition, sequence) tuples that key its
 * Messages. The second kind is what ties a line's *recording* to its *text* and
 * its mouth timing without any table joining them (#222).
 */

import type { VolumeReader } from '../../resource/VolumeReader.js';
import type { SciMessageKey } from '../resource/sciMessage.js';

/**
 * The base audio map's own number.
 *
 * 65535 is not a room, which is how a release says "this table is the whole
 * game's": every other `map` resource is numbered for the room whose speech it
 * keys.
 */
export const SCI_BASE_AUDIO_MAP = 65535;

/** Where one sample lives in an audio Volume. */
export interface SciAudioEntry {
  /** The plain resource number, for a base map. */
  number?: number;
  /** The Message tuple, for a per-room map. */
  key?: SciMessageKey;
  offset: number;
  /** Which Volume — `RESOURCE.AUD` or `RESOURCE.SFX`. */
  volume: 'aud' | 'sfx';
}

/**
 * Reads the base audio map, numbered 65535.
 *
 * Six bytes an entry: a 16-bit resource number and a 32-bit offset. Verified
 * against Freddy Pharkas's demo, whose offsets rise monotonically from zero and
 * stay inside its `RESOURCE.AUD` — which is the check worth making, because a
 * table read at the wrong width still produces numbers and they are still in
 * range for the first few entries.
 */
export function readSciAudioMap(resource: Uint8Array): SciAudioEntry[] {
  const entries: SciAudioEntry[] = [];
  for (let at = 0; at + 6 <= resource.length; at += 6) {
    const number = resource[at] | (resource[at + 1] << 8);
    if (number === 0xffff) break;
    const offset =
      (resource[at + 2] |
        (resource[at + 3] << 8) |
        (resource[at + 4] << 16) |
        (resource[at + 5] << 24)) >>>
      0;
    entries.push({ number, offset, volume: 'aud' });
  }
  return entries;
}

/**
 * Reads a per-room audio map, whose entries are keyed by Message tuple.
 *
 * Eleven bytes: the four-part key, then a 32-bit offset, then a size and a
 * flag. The key is the *same* one the Message and its `sync36` carry, which is
 * why a line's three faces need no table to join them — the tuple is the join.
 */
export function readSciAudio36Map(resource: Uint8Array, stride = 0): SciAudioEntry[] {
  const entries: SciAudioEntry[] = [];
  if (stride === 0) return entries;

  // A five-byte header: the map's own number and a flag byte.
  let at = 5;
  while (at + stride <= resource.length) {
    const noun = resource[at];
    if (noun === 0xff) break;

    // The key is the leading bytes and the offset the trailing four. The
    // *number* of key bytes is what differs between the widths — three at the
    // narrow one and four at the wide — which is why the offset is read from
    // the end of the entry rather than from a fixed position.
    const key: SciMessageKey = {
      noun,
      verb: resource[at + 1],
      cond: resource[at + 2],
      seq: stride >= 8 ? resource[at + 3] : 0,
    };
    const offsetAt = at + stride - 4;
    const offset =
      (resource[offsetAt] |
        (resource[offsetAt + 1] << 8) |
        (resource[offsetAt + 2] << 16) |
        (resource[offsetAt + 3] << 24)) >>>
      0;
    entries.push({ key, offset, volume: 'aud' });
    at += stride;
  }
  return entries;
}

/**
 * Which entry width a per-room audio map uses, from whether its offsets land
 * on samples.
 *
 * The same method as the compression-era probe and for the same reason: the
 * widths that exist across the family are known, and which one a release uses
 * is not predicted by its Version — Freddy Pharkas ships RIFF WAVE where Space
 * Quest 6 ships SOL, and neither is a fault. So both widths are tried and the
 * one whose offsets point at real sample headers is the right one.
 *
 * Self-validating, which is what makes it safe: a wrong width produces offsets
 * that are not sample headers, and a sample header is five bytes of signature
 * rather than something that occurs by chance.
 */
export async function detectAudio36Stride(
  resource: Uint8Array,
  volumes: VolumeReader,
  file: string,
): Promise<{ stride: number; matched: number }> {
  let best = { stride: 0, matched: 0 };

  for (const stride of [7, 8, 11, 12]) {
    const entries = readSciAudio36Map(resource, stride).slice(0, 8);
    if (entries.length === 0) continue;

    let matched = 0;
    for (const entry of entries) {
      const head = await volumes.read(file, entry.offset, 64);
      if (readSciAudioHeader(head)) matched++;
    }
    if (matched > best.matched) best = { stride, matched };
  }
  return best;
}

/** A decoded sample's shape, without its bytes. */
export interface SciAudioSample {
  sampleRate: number;
  /** Bytes of audio following the header. */
  length: number;
  /** True for 16-bit signed, false for 8-bit unsigned. */
  sixteenBit: boolean;
  /** True when the sample is DPCM-compressed rather than raw. */
  compressed: boolean;
  /** Where the audio starts, which differs between the two containers. */
  dataOffset: number;
}

/**
 * Sierra's own audio header.
 *
 * `0x8d`, then a **header size byte**, then `SOL\0` — and the size byte in the
 * middle is the thing to get right. Reading the signature as five contiguous
 * bytes from zero fails on every sample in every game, which is how this was
 * found: Space Quest 6's `RESOURCE.AUD` opens `8d 0c 53 4f 4c 00` and the
 * check was looking for `8d 53 4f 4c 00`.
 */
const SOL_MARKER = 0x8d;
const SOL_TAG = [0x53, 0x4f, 0x4c, 0x00];

/** Some releases ship plain RIFF WAVE instead, which is not a fault. */
const RIFF_TAG = [0x52, 0x49, 0x46, 0x46];

/**
 * Whether these bytes open a RIFF WAVE rather than one of Sierra's own.
 *
 * Exported because the two containers are handed on differently and the caller
 * has to know which it has: a RIFF sample is already a file and is passed
 * through whole, where a SOL one is a header and raw PCM and has a WAVE written
 * around it. Asking here rather than re-reading the four bytes somewhere else
 * keeps one statement of what RIFF looks like.
 */
export function looksLikeRiffSample(head: Uint8Array): boolean {
  return RIFF_TAG.every((byte, index) => head[index] === byte);
}

/**
 * Reads a sample's header.
 *
 * Returns null for bytes that are not a sample, which is how a wrong offset
 * announces itself. A reader that assumed a header would play whatever is at
 * the offset as audio — noise at some length, which is the one fault class that
 * cannot be seen in a report and can only be heard.
 */
export function readSciAudioHeader(head: Uint8Array): SciAudioSample | null {
  if (head.length < 14) return null;

  // A RIFF WAVE, which Freddy Pharkas's demo ships instead of SOL. Recognised
  // rather than refused: a release choosing the other container is not a fault
  // and there is no Version that predicts which.
  if (looksLikeRiffSample(head)) {
    return {
      sampleRate: (head[24] | (head[25] << 8) | (head[26] << 16) | (head[27] << 24)) >>> 0,
      length: (head[4] | (head[5] << 8) | (head[6] << 16) | (head[7] << 24)) >>> 0,
      sixteenBit: head[34] === 16,
      compressed: false,
      dataOffset: 44,
    };
  }

  if (head[0] !== SOL_MARKER) return null;
  if (!SOL_TAG.every((byte, index) => head[index + 2] === byte)) return null;

  const flags = head[8];
  return {
    sampleRate: head[6] | (head[7] << 8),
    length: (head[9] | (head[10] << 8) | (head[11] << 16) | (head[12] << 24)) >>> 0,
    // Bit 2 is sixteen-bit and bit 0 is DPCM. A sample decoded at the wrong
    // width is audible and a sample decoded as raw when it is DPCM is noise,
    // so neither is a flag to guess at.
    sixteenBit: (flags & 0x04) !== 0,
    compressed: (flags & 0x01) !== 0,
    // Past the marker, the size byte and the header the size byte measures.
    dataOffset: 2 + head[1],
  };
}

/**
 * Fetches one sample's bytes, and nothing else.
 *
 * The header first, then exactly what it declares — two range reads out of a
 * file that may be hundreds of megabytes. Nothing here holds the Volume, which
 * is the property ADR 0021 exists for and the reason this takes a
 * `VolumeReader` rather than a buffer.
 */
export async function readSciAudioSample(
  volumes: VolumeReader,
  file: string,
  offset: number,
): Promise<{ header: SciAudioSample; body: Uint8Array } | null> {
  const head = await volumes.read(file, offset, 64);
  const header = readSciAudioHeader(head);
  if (!header) return null;

  const body = await volumes.read(file, offset + header.dataOffset, header.length);
  return { header, body };
}
