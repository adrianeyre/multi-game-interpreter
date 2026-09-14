/**
 * Broken Sword's speech container, which is not a cluster.
 *
 * Every other byte this family reads is addressed through `swordres.rif`.
 * Speech is not: it lives in one file beside the install — `SPEECH1.CLU` on a
 * retail disc, `SPEECH/SPEECH.CLU` on a disc-layout copy, `SPEECH/COWS.MAD` in
 * the demo — with an index of its own at the front and no entry in the RIF at
 * all. Asking the resource system for a speech id therefore finds nothing,
 * which is why this reader exists rather than a cluster label.
 *
 * ## The index
 *
 * A `u32` length, then that many bytes less four of `u32`s. The first entries
 * are one per *room*, each holding four times the word offset at which that
 * room's lines begin; from there the lines are `(offset, length)` pairs read
 * one word early, so line `n` of a room is at `words[base + n * 2 - 1]` with
 * length `words[base + n * 2]`. A length of zero is a line the release did not
 * record. Payload offsets are relative to the end of the index, so the bytes
 * are at `offset + indexBytes` in the file (`sound.cpp:528` and `:539`).
 *
 * The off-by-one in the pair lookup is the original's, not a transcription
 * slip: a room's block and the next room's overlap by exactly one word, so
 * room `r`'s last length is the word the next room's block starts at and
 * nothing is wasted between them. That overlap is also how a room's line count
 * is recovered — the index never states one — which matters because a line the
 * release did not record has a length of zero *in the middle of a block*, so
 * stopping at the first zero would find one line of the demo's room 0 and miss
 * the seventy-five after it.
 */

import { readRangeFrom, type DataSource } from '../../resource/DataSource.js';

/** One recorded line: where it is in the container and how long it is. */
export interface Sword1SpeechEntry {
  readonly room: number;
  readonly line: number;
  /** Byte offset within the container, index included. */
  readonly at: number;
  readonly length: number;
  /**
   * Which index word holds this line's length; the word before it holds the
   * offset.
   *
   * Carried on the entry because a rebuild has to write both back, and
   * recovering them from `room` and `line` means redoing the block walk in a
   * second place — which is the kind of duplication that stays right until one
   * of the two is fixed.
   */
  readonly lengthAt: number;
}

/** A speech container's index, opened without reading the recordings. */
export interface Sword1SpeechIndex {
  readonly file: string;
  /** How long the index itself is; payload offsets are measured from its end. */
  readonly indexBytes: number;
  readonly words: Uint32Array;
  /** Where line `n` of `room` is, or null when this release did not record it. */
  locate(room: number, line: number): Sword1SpeechEntry | null;
  /** Every line the index names, ascending by room then line. */
  entries(): Sword1SpeechEntry[];
}

/**
 * How many rooms the index describes.
 *
 * Read from the index rather than assumed, because the demo's is far shorter
 * than a retail disc's. The first room entry's own value is where the pairs
 * start, and the room table cannot reach past that — so the count is that
 * offset in words, which is what the original's `>> 2` on a byte offset says
 * from the other side.
 */
function roomCount(words: Uint32Array): number {
  let smallest = words.length;
  for (let room = 0; room < words.length && room < smallest; room++) {
    const at = (words[room] as number) >>> 2;
    if (at > 0 && at < smallest) smallest = at;
  }
  return smallest;
}

/**
 * Where each room's block of lines starts, and how many lines it holds.
 *
 * A block runs to the next room that has one, and the last runs to the end of
 * the index. Rooms with no recordings carry a zero and are skipped rather than
 * given a zero-length block, because a zero is "this room says nothing", not
 * "this room's block is here and empty".
 */
function blocks(words: Uint32Array, rooms: number): Map<number, { at: number; lines: number }> {
  const bases: { room: number; at: number }[] = [];
  for (let room = 0; room < rooms; room++) {
    const at = (words[room] as number) >>> 2;
    if (at > 0 && at < words.length) bases.push({ room, at });
  }
  bases.sort((left, right) => left.at - right.at);
  const found = new Map<number, { at: number; lines: number }>();
  for (let index = 0; index < bases.length; index++) {
    const entry = bases[index] as { room: number; at: number };
    const next = bases[index + 1]?.at ?? words.length;
    found.set(entry.room, { at: entry.at, lines: Math.max(0, (next - entry.at) >> 1) });
  }
  return found;
}

/**
 * How long a container's index is, from its first four bytes, or null.
 *
 * A plausible index is a whole number of words, big enough to hold a room
 * table and small enough to be an index rather than the recordings. Both
 * bounds are here because a file that is not a speech container at all — a
 * cluster, a video — will read some other four bytes as a length and would
 * otherwise be walked as though it were one.
 */
export function sword1SpeechIndexBytes(head: Uint8Array): number | null {
  if (head.length < 4) return null;
  const indexBytes = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0, true);
  if (indexBytes < 8 || indexBytes % 4 !== 0 || indexBytes > 1 << 22) return null;
  return indexBytes;
}

/**
 * Reads the index out of bytes already in hand, or null when they are not one.
 *
 * The whole of the reading; `readSword1SpeechIndex` is this plus the two range
 * reads that fetch the index without fetching the 43.9 MB behind it. Separate
 * because an **export** has the container in memory and is synchronous, and a
 * second walk written for it would be a second thing to keep right.
 */
export function parseSword1SpeechIndex(file: string, head: Uint8Array): Sword1SpeechIndex | null {
  const indexBytes = sword1SpeechIndexBytes(head);
  if (indexBytes === null || head.length < indexBytes) return null;
  const bytes = head.subarray(4, indexBytes);
  const words = new Uint32Array(indexBytes / 4 - 1);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at < words.length; at++) words[at] = view.getUint32(at * 4, true);

  const rooms = roomCount(words);
  const byRoom = blocks(words, rooms);

  const locate = (room: number, line: number): Sword1SpeechEntry | null => {
    const block = byRoom.get(room);
    if (!block || line < 1 || line > block.lines) return null;
    const lengthAt = block.at + line * 2;
    if (lengthAt >= words.length) return null;
    const length = words[lengthAt] as number;
    const offset = words[lengthAt - 1] as number;
    if (length === 0) return null;
    return { room, line, at: offset + indexBytes, length, lengthAt };
  };

  const entries = (): Sword1SpeechEntry[] => {
    const found: Sword1SpeechEntry[] = [];
    for (const [room, block] of [...byRoom].sort((left, right) => left[0] - right[0])) {
      for (let line = 1; line <= block.lines; line++) {
        const entry = locate(room, line);
        if (entry) found.push(entry);
      }
    }
    return found;
  };

  return { file, indexBytes, words, locate, entries };
}

/** Reads a container's index, or null when the file is not one. */
export async function readSword1SpeechIndex(
  source: DataSource,
  file: string,
): Promise<Sword1SpeechIndex | null> {
  const head = await readRangeFrom(source, file, 0, 4);
  if (!head) return null;
  const indexBytes = sword1SpeechIndexBytes(head);
  if (indexBytes === null) return null;
  const bytes = await readRangeFrom(source, file, 0, indexBytes);
  if (!bytes || bytes.length < indexBytes) return null;
  return parseSword1SpeechIndex(file, bytes);
}
