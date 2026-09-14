import { SMALL_CHUNKS, iterateChunks, readSmallChunkHeader } from '../engine/resource/Chunk.js';
import { readU16LE, readU32LE } from '../engine/util/ByteStream.js';

/**
 * Writes a SCUMM v4 game back out, with some of its scripts replaced.
 *
 * `exportGame.ts` calls itself version-agnostic, and it is — within one
 * Resource layout. That agnosticism is a property of the `LECF` container and
 * not of SCUMM: it never asks what a resource *is*, but it does know that a
 * game is one file with one directory of rooms in it. v4 is neither. It is
 * `000.LFL` plus up to nine `DISKnn.LEC`, with two character tags and
 * little-endian sizes, and a room living in exactly one of those files.
 *
 * So the **principle** survives untouched — copy what was not touched,
 * substitute what was, rebuild the index — and there is a second writer.
 *
 * Layout being rebuilt, per disk:
 *
 *   LE                      the file
 *     FO                    room number -> file offset of its LF
 *     LF   <room number>    one block per room
 *       RO SC SO CO         resources, addressed by offset from the `RO` block
 *
 * The last line is the difference that matters most. A v5 directory entry
 * counts from the block's own header; a v4 one counts from the `RO` inside it,
 * eight bytes further in. Rebuilding with v5's convention puts every resource
 * in the game eight bytes out — which is not a crash, it is a game that loads
 * and hands every script the tail of the one before it.
 */

export interface LecReplacement {
  /** Room whose block the resource lives in. */
  room: number;
  /** Offset of the resource, as the index records it: from the `RO` block. */
  offset: number;
  /** The replacement block, header and all. */
  block: Uint8Array;
}

export interface ExportedLecGame {
  index: Uint8Array;
  /** One buffer per input disk, in the same order. */
  disks: Uint8Array[];
}

/** Index directories whose entries address a resource inside a disk block. */
const RESOURCE_DIRECTORIES = new Set(['0S', '0N', '0C']);

/**
 * The `RO` block sits eight bytes into its `LF`: six of header and the room
 * number after it. Every directory offset in the index is counted from there.
 */
const ROOM_BLOCK_OFFSET = 8;

/**
 * Rebuilds a v4 game's files with the given resources replaced.
 *
 * Every buffer arrives decrypted and leaves decrypted. v4 is the Version where
 * that matters most: its index and charsets are stored in the clear and its
 * containers are XORed with 0x69, so a caller that encrypted the whole set with
 * one key would produce an install no interpreter can read.
 */
export function rewriteLecGame(
  index: Uint8Array,
  disks: readonly Uint8Array[],
  replacements: readonly LecReplacement[],
): ExportedLecGame {
  const byRoom = new Map<number, Map<number, Uint8Array>>();
  for (const replacement of replacements) {
    const room = byRoom.get(replacement.room) ?? new Map<number, Uint8Array>();
    room.set(replacement.offset, replacement.block);
    byRoom.set(replacement.room, room);
  }

  /** room -> (old resource offset -> new resource offset), both from `RO`. */
  const moved = new Map<number, Map<number, number>>();
  const rebuilt = disks.map((disk) => rewriteDisk(disk, byRoom, moved));

  return { index: rewriteLflIndex(index, moved), disks: rebuilt };
}

function rewriteDisk(
  disk: Uint8Array,
  byRoom: Map<number, Map<number, Uint8Array>>,
  moved: Map<number, Map<number, number>>,
): Uint8Array {
  const container = readSmallChunkHeader(disk, 0);
  if (container.tag !== 'LE') throw new Error('Not a SCUMM v4 disk container (no LE block)');

  const directory = findSmall(disk, container, 'FO');
  if (!directory) throw new Error('Not a SCUMM v4 disk container (no FO block)');

  const blocks: Array<{ room: number; bytes: Uint8Array }> = [];

  for (const block of iterateChunks(
    disk,
    container.dataOffset,
    container.offset + container.size,
    SMALL_CHUNKS,
  )) {
    if (block.tag !== 'LF') continue;

    const room = readU16LE(disk, block.dataOffset);
    const substitutions = byRoom.get(room);
    const offsets = new Map<number, number>();

    // The room number, then the resources. It is part of the `LF` payload
    // rather than of the header, which is why the resources start two bytes
    // in and the directory offsets count from there.
    const payload: number[] = [disk[block.dataOffset], disk[block.dataOffset + 1]];

    for (const resource of iterateChunks(
      disk,
      block.dataOffset + 2,
      block.offset + block.size,
      SMALL_CHUNKS,
    )) {
      const oldOffset = resource.offset - (block.dataOffset + 2);
      offsets.set(oldOffset, payload.length - 2);

      const replacement = substitutions?.get(oldOffset);
      const bytes = replacement ?? disk.subarray(resource.offset, resource.offset + resource.size);
      payload.push(...bytes);
    }

    moved.set(room, offsets);
    blocks.push({ room, bytes: new Uint8Array(payload) });
  }

  // `FO` is a fixed size once the block count is known, so the file offsets can
  // be laid out before anything is written: the `LE` header, then `FO`, then
  // each block in the order it already had.
  const directorySize = 6 + 1 + blocks.length * 5;
  let at = 6 + directorySize;
  const fileOffsets: number[] = [];
  for (const block of blocks) {
    fileOffsets.push(at);
    at += block.bytes.length + 6;
  }

  const directoryPayload: number[] = [blocks.length];
  blocks.forEach((block, i) => {
    directoryPayload.push(block.room, ...u32le(fileOffsets[i]));
  });

  return new Uint8Array(
    smallChunk('LE', [
      ...smallChunk('FO', directoryPayload),
      ...blocks.flatMap((block) => smallChunk('LF', [...block.bytes])),
    ]),
  );
}

/**
 * Rewrites the v4 index's directory offsets to where their resources moved.
 *
 * Two differences from the `LECF` writer, both of them layout rather than
 * principle. The entries are **interleaved** — a room number and an offset per
 * entry — where v5 stores two columns. And the *room* directory is not
 * rewritten at all: its "room number" column is the disk number and its offsets
 * are zero, because a v4 room is found through its disk's own `FO` table rather
 * than through the index.
 *
 * Everything else — the room names, the global object table — is copied through
 * untouched, for the same reason the other writer copies them: none of it
 * addresses the data files, so none of it can be wrong after a rewrite, and
 * copying beats regenerating precisely because this code does not understand
 * most of it.
 */
function rewriteLflIndex(index: Uint8Array, moved: Map<number, Map<number, number>>): Uint8Array {
  const out: number[] = [];

  for (const block of iterateChunks(index, 0, index.length, SMALL_CHUNKS)) {
    if (!RESOURCE_DIRECTORIES.has(block.tag)) {
      out.push(...index.subarray(block.offset, block.offset + block.size));
      continue;
    }

    const count = readU16LE(index, block.dataOffset);
    const payload: number[] = [...u16le(count)];

    for (let i = 0; i < count; i++) {
      const at = block.dataOffset + 2 + i * 5;
      const room = index[at];
      const offset = readU32LE(index, at + 1);
      // An entry pointing nowhere stays pointing nowhere; a resource whose
      // offset is not in the map was not in a container to begin with, and
      // inventing an offset for it would be worse than leaving it.
      const next = moved.get(room)?.get(offset);
      payload.push(room, ...u32le(next ?? offset));
    }

    out.push(...smallChunk(block.tag, payload));
  }

  return new Uint8Array(out);
}

/**
 * Rebuilds an `RO` room block with some of the scripts inside it replaced.
 *
 * The same shape as the `LECF` writer's `replaceRoomScripts`, and separate for
 * the same reason the whole file is: a v4 room's children carry two character
 * tags and little-endian sizes, so a walk written for one cannot read the
 * other. Nothing inside a room addresses another part of it by stored offset,
 * so re-emitting the children in order with one swapped is safe even though
 * the ones after it move.
 */
export function replaceSmallRoomScripts(
  room: Uint8Array,
  replacements: Map<number, Uint8Array>,
): Uint8Array {
  const header = readSmallChunkHeader(room, 0);
  if (header.tag !== 'RO') throw new Error('Not a v4 room resource');

  const payload: number[] = [];
  for (const child of iterateChunks(
    room,
    header.dataOffset,
    header.offset + header.size,
    SMALL_CHUNKS,
  )) {
    const replacement = replacements.get(child.offset);
    payload.push(...(replacement ?? room.subarray(child.offset, child.offset + child.size)));
  }

  return new Uint8Array(smallChunk('RO', payload));
}

/**
 * Builds the replacement block for one edited v4 script.
 *
 * The block keeps its tag and whatever its payload carried before the code —
 * `LS`'s script number — and only the code changes.
 */
export function rebuildSmallScriptBlock(
  room: Uint8Array,
  blockOffset: number,
  prefix: number,
  code: Uint8Array,
): Uint8Array {
  const header = readSmallChunkHeader(room, blockOffset);
  const payload = [...room.subarray(header.dataOffset, header.dataOffset + prefix), ...code];
  return new Uint8Array(smallChunk(header.tag, payload));
}

/** Where a room's `RO` block sits inside its `LF`, for a caller addressing it. */
export function roomBlockOffset(): number {
  return ROOM_BLOCK_OFFSET;
}

function findSmall(
  data: Uint8Array,
  parent: { dataOffset: number; dataSize: number },
  tag: string,
) {
  for (const child of iterateChunks(
    data,
    parent.dataOffset,
    parent.dataOffset + parent.dataSize,
    SMALL_CHUNKS,
  )) {
    if (child.tag === tag) return child;
  }
  return undefined;
}

/** A pre-v5 chunk: a little-endian size, then a two character tag. */
export function smallChunk(tag: string, payload: number[]): number[] {
  const size = payload.length + 6;
  return [...u32le(size), tag.charCodeAt(0), tag.charCodeAt(1), ...payload];
}

function u16le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}
