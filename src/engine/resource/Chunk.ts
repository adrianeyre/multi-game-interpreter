import { readTag, readU32BE, readU32LE } from '../util/ByteStream.js';

/**
 * SCUMM v5 data is a tree of chunks. Each chunk is an 8 byte header — a four
 * character tag followed by a big-endian size that *includes* the header —
 * followed by either raw payload or further chunks.
 *
 *   LECF                      the whole data file
 *     LOFF                    room number -> file offset table
 *     LFLF                    one disk block per room
 *       ROOM                  the room itself
 *         RMHD OBIM OBCD ...
 *       SCRP SOUN COST CHAR   global resources that live in this block
 */
export interface Chunk {
  readonly tag: string;
  /** Offset of the chunk header within the containing buffer. */
  readonly offset: number;
  /** Total size including the 8 byte header. */
  readonly size: number;
  /** Offset of the first payload byte. */
  readonly dataOffset: number;
  /** Payload size, i.e. `size - 8`. */
  readonly dataSize: number;
}

export const CHUNK_HEADER_SIZE = 8;

/** A v4 header: a little-endian size, then a *two* character tag. */
export const SMALL_CHUNK_HEADER_SIZE = 6;

/**
 * How a Resource layout writes a chunk header.
 *
 * Two of them, and they share no bytes at all. v5 and later put a four
 * character tag first and a big-endian size after it; v4 and earlier put a
 * little-endian size first and a two character tag after it. Both sizes include
 * the header.
 *
 * A parameter rather than a version check at each call site, because the
 * readers above it — rooms, objects, costumes — differ from their v5
 * equivalents in *which tags* they look for and not in how they walk. Passing
 * the format down keeps the walk in one place, which is where the off-by-header
 * faults this codebase has already met would otherwise multiply.
 */
export interface ChunkFormat {
  readonly headerSize: number;
  read(data: Uint8Array, offset: number): Chunk;
}

export function readChunkHeader(data: Uint8Array, offset: number): Chunk {
  const tag = readTag(data, offset);
  const size = readU32BE(data, offset + 4);
  return {
    tag,
    offset,
    size,
    dataOffset: offset + CHUNK_HEADER_SIZE,
    dataSize: size - CHUNK_HEADER_SIZE,
  };
}

export function readSmallChunkHeader(data: Uint8Array, offset: number): Chunk {
  const size = readU32LE(data, offset);
  const tag = String.fromCharCode(data[offset + 4] ?? 0, data[offset + 5] ?? 0);
  return {
    tag,
    offset,
    size,
    dataOffset: offset + SMALL_CHUNK_HEADER_SIZE,
    dataSize: size - SMALL_CHUNK_HEADER_SIZE,
  };
}

/** v5-v8: a four character tag, then a big-endian size. */
export const BIG_CHUNKS: ChunkFormat = {
  headerSize: CHUNK_HEADER_SIZE,
  read: readChunkHeader,
};

/** v2-v4: a little-endian size, then a two character tag. */
export const SMALL_CHUNKS: ChunkFormat = {
  headerSize: SMALL_CHUNK_HEADER_SIZE,
  read: readSmallChunkHeader,
};

/** The format a SCUMM Version writes its chunk headers in. */
export function chunkFormatFor(version: number): ChunkFormat {
  return version >= 5 ? BIG_CHUNKS : SMALL_CHUNKS;
}

/**
 * Walks the direct children of a container chunk.
 *
 * Stops on a zero or negative size rather than looping forever, because
 * truncated or mis-decrypted files show up exactly that way and a hang is a
 * far worse diagnostic than a short read.
 */
export function* iterateChunks(
  data: Uint8Array,
  start: number,
  end: number = data.length,
  format: ChunkFormat = BIG_CHUNKS,
): Generator<Chunk> {
  let offset = start;
  while (offset + format.headerSize <= end) {
    const chunk = format.read(data, offset);
    if (chunk.size < format.headerSize || offset + chunk.size > end) {
      // Trailing padding or a malformed block; treat as end of container.
      return;
    }
    yield chunk;
    offset += chunk.size;
  }
}

/** The first direct child with the given tag, or `undefined`. */
export function findChunk(
  data: Uint8Array,
  start: number,
  tag: string,
  end?: number,
  format: ChunkFormat = BIG_CHUNKS,
): Chunk | undefined {
  for (const chunk of iterateChunks(data, start, end, format)) {
    if (chunk.tag === tag) return chunk;
  }
  return undefined;
}

/** All direct children with the given tag. */
export function findChunks(
  data: Uint8Array,
  start: number,
  tag: string,
  end?: number,
  format: ChunkFormat = BIG_CHUNKS,
): Chunk[] {
  const out: Chunk[] = [];
  for (const chunk of iterateChunks(data, start, end, format)) {
    if (chunk.tag === tag) out.push(chunk);
  }
  return out;
}

/**
 * Depth-first search for a tag, descending into every chunk.
 *
 * The engine mostly wants direct children, but a few lookups (IMHD inside an
 * OBIM, SMAP inside RMIM/IM00) are naturally expressed as "find this somewhere
 * beneath here".
 */
export function findChunkDeep(
  data: Uint8Array,
  start: number,
  tag: string,
  end?: number,
  maxDepth = 6,
): Chunk | undefined {
  if (maxDepth < 0) return undefined;
  for (const chunk of iterateChunks(data, start, end)) {
    if (chunk.tag === tag) return chunk;
    const nested = findChunkDeep(
      data,
      chunk.dataOffset,
      tag,
      chunk.dataOffset + chunk.dataSize,
      maxDepth - 1,
    );
    if (nested) return nested;
  }
  return undefined;
}

export function chunkData(data: Uint8Array, chunk: Chunk): Uint8Array {
  return data.subarray(chunk.dataOffset, chunk.dataOffset + chunk.dataSize);
}
