import { decompressBundleBlock } from './bundleCodecs.js';
/**
 * The `.BUN` bundles a v7 game keeps its speech and music in.
 *
 * The successor to a Talkie's single `MONSTER.SOU`, and read the same way: a
 * container addressed by name, with nothing to enumerate at play time and only
 * asked for. Full Throttle and The Dig both ship a speech bundle and a music
 * one, and together they are the bulk of a v7 install — which is why #114 names
 * them as the strongest argument for range-reading rather than loading whole.
 *
 * The layout, from `BundleDirCache::matchFile` and `BundleMgr::loadCompTable`:
 *
 *     tag        u32be   'LB83', or 'LB23' for the variant with long names
 *     dirOffset  u32be   where the directory starts
 *     fileCount  u32be
 *     ...
 *     directory  fileCount entries of: a name, then offset and size as u32be
 *
 * A name is stored as eight bytes of stem and four of extension, each NUL
 * padded, joined with a dot — so `ROADHOUS` and `WAV` become `ROADHOUS.WAV`.
 * The `LB23` variant stores twenty-four bytes of name instead. Everything is
 * **big-endian**, unlike the SCUMM index.
 *
 * Each entry's own data then begins with one of two tags:
 *
 * - `iMUS`: the sample is stored uncompressed and the entry is the sound.
 * - `COMP`: a table of compressed blocks, each with its own codec.
 */

/** Decompressed size of every block but the last, from `DIMUSE_BUN_CHUNK_SIZE`. */
export const BUNDLE_BLOCK_SIZE = 0x2000;

export interface BundleEntry {
  /** `ROADHOUS.WAV`, upper case, as the directory stores it. */
  name: string;
  offset: number;
  size: number;
}

export interface Bundle {
  readonly entries: ReadonlyMap<string, BundleEntry>;
  /** Which file this is, for diagnostics and for #113's origin record. */
  readonly source: string;
}

/** One block of a `COMP` entry: where it is, how big, and how it is encoded. */
export interface CompressedBlock {
  offset: number;
  size: number;
  codec: number;
}

export interface BundleSample {
  /** 'uncompressed' when the entry is a bare `iMUS`, 'compressed' for `COMP`. */
  kind: 'uncompressed' | 'compressed';
  /** For an uncompressed sample, the `iMUS` bytes. Empty when compressed. */
  data: Uint8Array;
  /** For a compressed sample, its block table. Empty when uncompressed. */
  blocks: CompressedBlock[];
  /** Decompressed size of the final block, which is not a whole one. */
  lastBlockSize: number;
}

function readTag(bytes: Uint8Array, at: number): string {
  let tag = '';
  for (let i = 0; i < 4; i++) tag += String.fromCharCode(bytes[at + i]);
  return tag;
}

/**
 * Reads a bundle's directory.
 *
 * Returns null when the file is not a bundle, rather than throwing: a missing
 * or wrong bundle is a game with no speech, and naming it is more use than an
 * exception from wherever a script first asks for a line.
 */
export function readBundle(bytes: Uint8Array, source: string): Bundle | null {
  if (bytes.length < 12) return null;

  const tag = readTag(bytes, 0);
  if (tag !== 'LB83' && tag !== 'LB23') return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const dirOffset = view.getUint32(4, false);
  const fileCount = view.getUint32(8, false);

  const entries = new Map<string, BundleEntry>();
  const longNames = tag === 'LB23';
  const nameBytes = longNames ? 24 : 12;
  let cursor = dirOffset;

  for (let i = 0; i < fileCount; i++) {
    if (cursor + nameBytes + 8 > bytes.length) break;

    let name: string;
    if (longNames) {
      name = '';
      for (let j = 0; j < 24; j++) {
        const ch = bytes[cursor + j];
        if (ch !== 0) name += String.fromCharCode(ch);
      }
    } else {
      // Eight of stem and four of extension, each NUL padded, joined by a dot.
      // Reading them as one twelve-byte string instead gives `ROADHOUSWAV`,
      // which never matches a lookup and produces a game with no sound and no
      // error.
      let stem = '';
      for (let j = 0; j < 8; j++) {
        const ch = bytes[cursor + j];
        if (ch !== 0) stem += String.fromCharCode(ch);
      }
      let extension = '';
      for (let j = 8; j < 12; j++) {
        const ch = bytes[cursor + j];
        if (ch !== 0) extension += String.fromCharCode(ch);
      }
      name = `${stem}.${extension}`;
    }

    const offset = view.getUint32(cursor + nameBytes, false);
    const size = view.getUint32(cursor + nameBytes + 4, false);
    entries.set(name.toUpperCase(), { name: name.toUpperCase(), offset, size });
    cursor += nameBytes + 8;
  }

  return { entries, source };
}

/**
 * The sample an entry holds, by the name a script or `ANAM` gives it.
 *
 * Case-insensitive, because the index's audio names and the bundle's directory
 * do not agree about case and a lookup that respected it would find nothing.
 */
export function readSample(bundle: Bundle, bytes: Uint8Array, name: string): BundleSample | null {
  const entry = bundle.entries.get(name.toUpperCase());
  if (!entry) return null;
  if (entry.offset + 4 > bytes.length) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const tag = readTag(bytes, entry.offset);

  if (tag === 'iMUS') {
    return {
      kind: 'uncompressed',
      data: bytes.subarray(entry.offset, entry.offset + entry.size),
      blocks: [],
      lastBlockSize: 0,
    };
  }

  if (tag !== 'COMP') return null;

  const blockCount = view.getUint32(entry.offset + 4, false);
  // Four bytes here that ScummVM skips, then the size the final block
  // decompresses to — which is not a whole block, and is what makes the total
  // decompressed length knowable without decoding anything.
  const lastBlockSize = view.getUint32(entry.offset + 12, false);

  const blocks: CompressedBlock[] = [];
  let cursor = entry.offset + 16;
  for (let i = 0; i < blockCount; i++) {
    if (cursor + 16 > bytes.length) break;
    blocks.push({
      offset: view.getUint32(cursor, false),
      size: view.getUint32(cursor + 4, false),
      codec: view.getUint32(cursor + 8, false),
    });
    cursor += 16;
  }

  return { kind: 'compressed', data: new Uint8Array(0), blocks, lastBlockSize };
}

/**
 * How many bytes a compressed sample decompresses to.
 *
 * Every block but the last is a whole `BUNDLE_BLOCK_SIZE`; the last is whatever
 * the header said. Worth having before any decoder exists, because this is the
 * length `Speech wait` needs — and the v6 lesson was that reading the wrong
 * length gives speech that is cut off or a wait that never returns, which is a
 * broken game even for a player with sound off.
 */
export function decompressedSize(sample: BundleSample): number {
  if (sample.kind === 'uncompressed') return sample.data.length;
  if (sample.blocks.length === 0) return 0;
  return (sample.blocks.length - 1) * BUNDLE_BLOCK_SIZE + sample.lastBlockSize;
}

/**
 * A compressed sample's bytes, decompressed block by block.
 *
 * Returns null when any block uses a codec this cannot decode, rather than a
 * partial buffer: audio with a hole in it is worse than none, because the hole
 * is silence at the right length and reads as a quiet recording rather than as
 * a failure. The caller names the codec it stopped on.
 */
export function decompressSample(
  sample: BundleSample,
  bytes: Uint8Array,
): { data: Uint8Array; unsupportedCodec: number | null } {
  if (sample.kind === 'uncompressed') {
    return { data: sample.data, unsupportedCodec: null };
  }

  const total = decompressedSize(sample);
  const out = new Uint8Array(total);
  let written = 0;

  for (const [index, block] of sample.blocks.entries()) {
    const last = index === sample.blocks.length - 1;
    const size = last ? sample.lastBlockSize : BUNDLE_BLOCK_SIZE;
    const input = bytes.subarray(block.offset, block.offset + block.size);

    const decoded = decompressBundleBlock(block.codec, input, size);
    if (!decoded) return { data: new Uint8Array(0), unsupportedCodec: block.codec };

    out.set(decoded.subarray(0, Math.min(decoded.length, total - written)), written);
    written += decoded.length;
  }

  return { data: out.subarray(0, written), unsupportedCodec: null };
}

/**
 * How many bytes of a bundle have to be read before its directory can be.
 *
 * The header names where the directory starts and how many entries it has, so a
 * bundle can be opened by reading twelve bytes, then the directory, and nothing
 * else — which is the point of #114: Full Throttle's bundles are the bulk of an
 * install and are never wanted whole.
 */
export const BUNDLE_HEADER_BYTES = 12;

/** Where a bundle's directory sits, and how big it is, from its header. */
export function readBundleHeader(
  header: Uint8Array,
): { tag: string; dirOffset: number; dirBytes: number } | null {
  if (header.length < BUNDLE_HEADER_BYTES) return null;

  let tag = '';
  for (let i = 0; i < 4; i++) tag += String.fromCharCode(header[i]);
  if (tag !== 'LB83' && tag !== 'LB23') return null;

  const view = new DataView(header.buffer, header.byteOffset);
  const dirOffset = view.getUint32(4, false);
  const fileCount = view.getUint32(8, false);
  // Names are 12 or 24 bytes, then an offset and a size.
  const entryBytes = (tag === 'LB23' ? 24 : 12) + 8;
  return { tag, dirOffset, dirBytes: fileCount * entryBytes };
}

/**
 * Reads a bundle's directory without reading the bundle.
 *
 * The header and the directory are contiguous enough to be fetched in two
 * range reads, which is a few kilobytes against several hundred megabytes.
 * `readBundle` still exists for a bundle already in memory — the fixture path,
 * and any source that cannot range-read.
 */
export function readBundleFromParts(
  header: Uint8Array,
  directory: Uint8Array,
  source: string,
): Bundle | null {
  const parsed = readBundleHeader(header);
  if (!parsed) return null;

  // Rebuild the shape `readBundle` expects: the header, then the directory at
  // the offset the header names. Padding rather than concatenation, so the
  // offsets in the header stay true.
  const combined = new Uint8Array(parsed.dirOffset + directory.length);
  combined.set(header.subarray(0, BUNDLE_HEADER_BYTES));
  combined.set(directory, parsed.dirOffset);
  return readBundle(combined, source);
}
