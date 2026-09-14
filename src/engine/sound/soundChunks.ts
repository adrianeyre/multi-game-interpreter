/**
 * Walking the blocks inside a `SOUN` resource, whose sizes are not the usual
 * ones.
 *
 * Everywhere else in a SCUMM file a chunk's size field counts the eight bytes
 * of its own header. Inside a `SOU ` container it does not: `readSoundResource`
 * reads the field and adds eight before stepping to the next block. Walked with
 * the ordinary rule the first block looks eight bytes short, the next tag is
 * read from inside the block's payload, and the walk stops — so a resource is
 * seen to contain only whichever arrangement happens to be stored first.
 *
 * Atlantis is the game that makes the cost of that obvious. Its music blocks are
 * stored `ROL ` (Roland MT-32), then `ADL ` (AdLib), then `SPK ` (PC speaker),
 * and the AdLib one is the only arrangement this engine can play. Nothing found
 * it, and no music was ever heard.
 */

const HEADER_SIZE = 8;

export interface SoundBlock {
  tag: string;
  /** Offset of the block's first payload byte. */
  offset: number;
  /** Payload length, header excluded. */
  size: number;
}

function readTag(data: Uint8Array, offset: number): string {
  return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
}

function readU32BE(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] << 24) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3]) >>>
    0
  );
}

/**
 * The arrangements a `SOUN` resource carries, in the order they are stored.
 *
 * Returns nothing for anything that is not a `SOUN` wrapping a `SOU `, which is
 * every other shape a sound can arrive in — a bare `ADL `, a raw MIDI file, a
 * v7 bundle cue — and which the callers handle their own way.
 */
export function listSoundBlocks(resource: Uint8Array): SoundBlock[] {
  if (resource.length < 24) return [];
  if (readTag(resource, 0) !== 'SOUN') return [];
  if (readTag(resource, 8) !== 'SOU ') return [];

  // The `SOU ` size excludes its own header, like the blocks inside it.
  const end = Math.min(resource.length, 16 + readU32BE(resource, 12));

  const blocks: SoundBlock[] = [];
  let cursor = 16;
  while (cursor + HEADER_SIZE <= end) {
    const size = readU32BE(resource, cursor + 4);
    // A block claiming to run past the container is a misread, not a truncated
    // file: stop rather than hand a caller a slice of the next resource.
    if (cursor + HEADER_SIZE + size > end) break;
    blocks.push({ tag: readTag(resource, cursor), offset: cursor + HEADER_SIZE, size });
    if (size === 0) break;
    cursor += HEADER_SIZE + size;
  }
  return blocks;
}

/**
 * The first block matching one of `tags`, tried in the order given.
 *
 * The order is the caller's preference, not the file's: the same piece is
 * stored several times over and which copy is wanted depends on what the
 * caller can play.
 */
export function findSoundBlock(resource: Uint8Array, tags: readonly string[]): SoundBlock | null {
  const blocks = listSoundBlocks(resource);
  for (const tag of tags) {
    const found = blocks.find((block) => block.tag === tag);
    if (found) return found;
  }
  return null;
}
