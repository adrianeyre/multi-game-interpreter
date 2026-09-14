/**
 * Recorded speech in an AGOS talkie release.
 *
 * A talkie keeps its speech in one large file — `SIMON.VOC`, `SIMON.WAV` and
 * their siblings — addressed by an offset table rather than enumerated, which
 * is the same shape `CONTEXT.md` describes for a SCUMM Talkie's `MONSTER.SOU`
 * and for AGOS's own resource archive.
 *
 * **The table is indexed differently from the archive's, by one word.** The
 * resource archive's first entry is its own size *and* the first resource's
 * offset; a speech file's first entry is an offset like any other and the
 * **second** holds the table's size. Reading one the way you read the other
 * gives a table one entry too long or too short, and offsets that are almost
 * right — the worst possible failure, because most sounds still play.
 *
 * Two entries may hold the **same** offset, and that means they are the same
 * recording rather than that one of them is missing — the games reuse a line
 * by pointing at it twice. The end of a recording is therefore the next
 * *different* offset, not the next one. What is genuinely absent is an entry
 * whose offset has reached the end of the file, and that is the only case this
 * reader drops.
 */

import { readWavePcm } from '../../sound/wave.js';

/** Where one recording is. */
export interface SpeechEntry {
  readonly index: number;
  readonly offset: number;
  readonly length: number;
}

export interface SpeechIndex {
  readonly entries: readonly SpeechEntry[];
  /** The bytes of one recording, or undefined when the game ships none for it. */
  read(index: number): Uint8Array | undefined;
}

function readU32(data: Uint8Array, at: number, bigEndian: boolean): number {
  const bytes = [data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0, data[at + 3] ?? 0];
  const ordered = bigEndian ? bytes : bytes.reverse();
  return ordered[0]! * 0x1000000 + ordered[1]! * 0x10000 + ordered[2]! * 0x100 + ordered[3]!;
}

/**
 * Reads the offset table at the front of a speech file.
 *
 * `base` exists because some releases put the speech after other data in the
 * same file, and every offset in the table is relative to it.
 */
export function readSpeechIndex(
  data: Uint8Array,
  options: { base?: number; bigEndian?: boolean } = {},
): SpeechIndex {
  const base = options.base ?? 0;
  const bigEndian = options.bigEndian ?? false;

  let tableBytes = readU32(data, base + 4, bigEndian);
  // The Feeble Files writes no size and uses a fixed count instead, which is
  // the kind of exception that has to be in the reader rather than in a caller.
  if (tableBytes === 0) tableBytes = 40_000;

  const count = Math.floor(tableBytes / 4);
  const offsets: number[] = [];
  for (let index = 0; index < count; index += 1) {
    offsets.push(base + readU32(data, base + index * 4, bigEndian));
  }
  offsets.push(data.length);

  const entries: SpeechEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = offsets[index]!;
    // Walk to the next *different* offset: entries that repeat this one are the
    // same recording, reused, and the reference plays them all.
    let next = index + 1;
    while (next < offsets.length && offsets[next] === start) next += 1;
    const end = offsets[next] ?? data.length;
    // An entry that has reached the end of the file is the one real absence.
    if (end <= start) continue;
    entries.push({ index, offset: start, length: end - start });
  }

  const byIndex = new Map(entries.map((entry) => [entry.index, entry]));
  return {
    entries,
    read(index) {
      const entry = byIndex.get(index);
      if (!entry) return undefined;
      return data.subarray(entry.offset, entry.offset + entry.length);
    },
  };
}

/** Decoded audio, ready for the browser to play. */
export interface DecodedSpeech {
  readonly sampleRate: number;
  /** Signed samples in the range -1..1, one channel. */
  readonly samples: Float32Array;
}

/**
 * Decodes a Creative VOC recording, which is what the DOS talkies ship.
 *
 * Only the block kinds the games use: block 1 is sound data with a rate byte,
 * block 9 is the later form with an explicit rate, block 0 ends the file, and
 * the rest are skipped. Anything else throws rather than producing noise —
 * silence would be indistinguishable from a line the game meant to be silent.
 */
export function decodeVoc(data: Uint8Array): DecodedSpeech {
  const header = new TextDecoder('latin1').decode(data.subarray(0, 19));
  if (!header.startsWith('Creative Voice File')) {
    throw new Error('not a Creative Voice File');
  }
  const dataOffset = (data[20] ?? 0) | ((data[21] ?? 0) << 8);

  let at = dataOffset;
  let sampleRate = 11_025;
  const pieces: Uint8Array[] = [];

  while (at < data.length) {
    const kind = data[at] ?? 0;
    if (kind === 0) break;
    const length = (data[at + 1] ?? 0) | ((data[at + 2] ?? 0) << 8) | ((data[at + 3] ?? 0) << 16);
    const body = at + 4;

    if (kind === 1) {
      // A frequency divisor, not a rate: the hardware's own arithmetic.
      const divisor = data[body] ?? 0;
      sampleRate = Math.round(1_000_000 / (256 - divisor));
      pieces.push(data.subarray(body + 2, body + length));
    } else if (kind === 9) {
      sampleRate =
        (data[body] ?? 0) |
        ((data[body + 1] ?? 0) << 8) |
        ((data[body + 2] ?? 0) << 16) |
        ((data[body + 3] ?? 0) << 24);
      pieces.push(data.subarray(body + 12, body + length));
    }

    at = body + length;
  }

  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const samples = new Float32Array(total);
  let write = 0;
  for (const piece of pieces) {
    for (const byte of piece) {
      // Unsigned 8-bit, so 128 is silence.
      samples[write++] = (byte - 128) / 128;
    }
  }
  return { sampleRate, samples };
}

/**
 * Decodes the PCM WAV the Windows talkies ship.
 *
 * The walk itself is `readWavePcm`, shared with the two other families that
 * read WAVE (ADR 0036 lets a codec cross where a record may not). What stays
 * here is the float conversion this engine's mixer wants and the two messages
 * that name which half of the file was wrong, because "not a WAVE" and "a
 * WAVE with no audio in it" send somebody to different places.
 */
export function decodeWav(data: Uint8Array): DecodedSpeech {
  const text = new TextDecoder('latin1');
  if (text.decode(data.subarray(0, 4)) !== 'RIFF' || text.decode(data.subarray(8, 12)) !== 'WAVE') {
    throw new Error('not a RIFF WAVE file');
  }
  const pcm = readWavePcm(data);
  if (!pcm) throw new Error('WAVE file has no data chunk');

  const samples = new Float32Array(pcm.samples.length);
  for (let at = 0; at < samples.length; at++) samples[at] = pcm.samples[at]! / 32_768;
  return { sampleRate: pcm.sampleRate, samples };
}

/**
 * Which decoder a recording needs, or `browser` for the re-encoded formats.
 *
 * ADR 0028 admits GOG, Steam and 25th Anniversary data, whose speech ScummVM's
 * tools re-encoded to MP3, Ogg or FLAC. Those go to the browser's own decoder,
 * which costs nothing and is why admitting them was cheap.
 */
export function speechKind(data: Uint8Array): 'voc' | 'wav' | 'browser' | 'unknown' {
  const text = new TextDecoder('latin1');
  if (text.decode(data.subarray(0, 19)).startsWith('Creative Voice File')) return 'voc';
  if (text.decode(data.subarray(0, 4)) === 'RIFF') return 'wav';
  if (text.decode(data.subarray(0, 4)) === 'OggS') return 'browser';
  if (text.decode(data.subarray(0, 4)) === 'fLaC') return 'browser';
  // An MP3 frame or an ID3 tag.
  if (text.decode(data.subarray(0, 3)) === 'ID3') return 'browser';
  if ((data[0] ?? 0) === 0xff && ((data[1] ?? 0) & 0xe0) === 0xe0) return 'browser';
  return 'unknown';
}
