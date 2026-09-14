import { MemoryDataSource } from './DataSource.js';

/**
 * A minimal ZIP reader.
 *
 * Games are distributed as zip archives, so requiring the user to extract one
 * before dropping it in is a step that only exists because we did not write
 * thirty lines of parser. Only the two compression methods archives actually
 * use are handled: stored, and deflate via the platform's own decompressor.
 */

interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;

function u16(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8);
}

function u32(data: Uint8Array, offset: number): number {
  return (
    (data[offset] |
      (data[offset + 1] << 8) |
      (data[offset + 2] << 16) |
      (data[offset + 3] << 24)) >>>
    0
  );
}

export function isZip(data: Uint8Array): boolean {
  // "PK\x03\x04" for a normal archive, "PK\x05\x06" for an empty one.
  return data.length > 4 && data[0] === 0x50 && data[1] === 0x4b;
}

/**
 * Reads the central directory.
 *
 * The directory lives at the end of the file, and its position is found by
 * scanning backwards for the end-of-central-directory signature — the format
 * has no forward pointer to it.
 */
function readCentralDirectory(data: Uint8Array): ZipEntry[] {
  let endOffset = -1;
  const scanLimit = Math.max(0, data.length - 0xffff - 22);
  for (let i = data.length - 22; i >= scanLimit; i--) {
    if (u32(data, i) === END_OF_CENTRAL_DIRECTORY) {
      endOffset = i;
      break;
    }
  }
  if (endOffset < 0) throw new Error('Not a valid zip archive (no central directory)');

  const entryCount = u16(data, endOffset + 10);
  let cursor = u32(data, endOffset + 16);

  const entries: ZipEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    if (u32(data, cursor) !== CENTRAL_FILE_HEADER) break;

    const compressionMethod = u16(data, cursor + 10);
    const compressedSize = u32(data, cursor + 20);
    const uncompressedSize = u32(data, cursor + 24);
    const nameLength = u16(data, cursor + 28);
    const extraLength = u16(data, cursor + 30);
    const commentLength = u16(data, cursor + 32);
    const localHeaderOffset = u32(data, cursor + 42);

    const name = new TextDecoder().decode(data.subarray(cursor + 46, cursor + 46 + nameLength));

    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress zip archives; please extract it first');
  }
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Compression methods by name, for the message when one is not supported.
 *
 * Naming it matters because the alternative is a *downstream* error: a zip
 * whose every file this reader skipped unpacks to nothing, and the engine then
 * says it found no index file — which sends you looking for the wrong problem
 * entirely. The demo zips on scummvm.org are 1993 archives compressed with
 * PKWARE's Implode, so this is the ordinary case rather than an exotic one.
 */
const METHOD_NAMES: Record<number, string> = {
  1: 'Shrink',
  2: 'Reduce',
  3: 'Reduce',
  4: 'Reduce',
  5: 'Reduce',
  6: 'Implode',
  9: 'Deflate64',
  12: 'bzip2',
  14: 'LZMA',
  93: 'Zstandard',
  95: 'XZ',
  98: 'PPMd',
};

function methodName(method: number): string {
  return METHOD_NAMES[method] ?? `method ${method}`;
}

/** Extracts every file, returning a data source the engine can load from. */
export async function readZip(data: Uint8Array, label = 'archive'): Promise<MemoryDataSource> {
  const source = new MemoryDataSource(label);
  const skipped = new Map<number, number>();
  let extracted = 0;

  for (const entry of readCentralDirectory(data)) {
    // Directories are stored as zero-length entries with a trailing slash.
    if (entry.name.endsWith('/')) continue;

    // The local header repeats the name and extra fields, and only it has the
    // real extra-field length, so the data offset must be computed from it.
    const local = entry.localHeaderOffset;
    const nameLength = u16(data, local + 26);
    const extraLength = u16(data, local + 28);
    const start = local + 30 + nameLength + extraLength;
    const raw = data.subarray(start, start + entry.compressedSize);

    let contents: Uint8Array;
    if (entry.compressionMethod === 0) {
      contents = raw;
    } else if (entry.compressionMethod === 8) {
      contents = await inflateRaw(raw);
    } else {
      // Skipped rather than fatal: one unreadable file should not stop a game
      // that does not need it. Counted, though, because a zip where *every*
      // file was skipped cannot succeed and should say so rather than let the
      // engine report a missing index.
      skipped.set(entry.compressionMethod, (skipped.get(entry.compressionMethod) ?? 0) + 1);
      continue;
    }

    source.set(entry.name, contents);
    extracted++;
  }

  if (extracted === 0 && skipped.size > 0) {
    const methods = [...skipped.keys()].map(methodName).join(', ');
    throw new Error(
      `Nothing in ${label} could be unpacked: every file is compressed with ` +
        `${methods}, which browsers cannot decompress — they read Deflate and ` +
        `stored entries only.\n\n` +
        `Extract the archive yourself and load the folder instead. Zips from ` +
        `scummvm.org are original 1993 archives and are usually Imploded.`,
    );
  }

  return source;
}
