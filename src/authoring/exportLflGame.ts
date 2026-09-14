import { SMALL_CHUNKS, iterateChunks } from '../engine/resource/Chunk.js';
import { readU16LE } from '../engine/util/ByteStream.js';

/**
 * Writes a SCUMM v2 or v3 game back out: an index and one file per room.
 *
 * The third and last writer, and the one where "rebuild the container" stops
 * meaning anything. There is no container. Export is a *set of files* — a
 * rebuilt `00.LFL` and one `NN.LFL` per room — so a resource growing does not
 * move anything after it in some larger blob. It makes one file bigger, and
 * only the offsets inside that file change.
 *
 * That is a smaller blast radius than either of the other two writers, and it
 * is worth saying why the code is not correspondingly simpler: the index's
 * offsets are sixteen bits. A room whose resources grow past 64 KB cannot be
 * addressed at all, and silently writing a truncated offset would produce an
 * install that loads and hands out the wrong bytes. So it is refused, by name.
 *
 * The principle is unchanged from `exportGame.ts`: copy what was not touched,
 * substitute what was, rebuild the index.
 */

export interface LflReplacement {
  /** Room whose file the resource lives in. */
  room: number;
  /** Offset of the resource within that room's file. */
  offset: number;
  /** The replacement block, header and all. */
  block: Uint8Array;
}

export interface ExportedLflGame {
  index: Uint8Array;
  /** Room number -> the file's new contents. */
  rooms: Map<number, Uint8Array>;
}

/**
 * The largest offset a v2/v3 index entry can hold.
 *
 * Sixteen bits, and 0xFFFF is the "not present" value rather than an address,
 * so the last usable offset is one below it.
 */
const MAX_LFL_OFFSET = 0xfffe;

/**
 * Rebuilds a v2/v3 game's files with the given resources replaced.
 *
 * Every buffer arrives decrypted and leaves decrypted, as with the other two
 * writers: the caller knows the key it read them with, and v3's is 0xFF where
 * v4's containers are 0x69.
 */
export function rewriteLflGame(
  index: Uint8Array,
  rooms: ReadonlyMap<number, Uint8Array>,
  replacements: readonly LflReplacement[],
  version: 2 | 3 = 3,
): ExportedLflGame {
  const byRoom = new Map<number, Map<number, Uint8Array>>();
  for (const replacement of replacements) {
    const room = byRoom.get(replacement.room) ?? new Map<number, Uint8Array>();
    room.set(replacement.offset, replacement.block);
    byRoom.set(replacement.room, room);
  }

  /** room -> (old resource offset -> new resource offset). */
  const moved = new Map<number, Map<number, number>>();
  const rebuilt = new Map<number, Uint8Array>();

  for (const [number, file] of rooms) {
    const substitutions = byRoom.get(number);
    if (!substitutions) {
      // Untouched files are carried through as they are rather than rebuilt.
      // Rebuilding would give the same bytes, and not rebuilding says so.
      rebuilt.set(number, file);
      continue;
    }

    const offsets = new Map<number, number>();
    const payload: number[] = [];

    for (const resource of iterateChunks(file, 0, file.length, SMALL_CHUNKS)) {
      offsets.set(resource.offset, payload.length);
      const replacement = substitutions.get(resource.offset);
      payload.push(
        ...(replacement ?? file.subarray(resource.offset, resource.offset + resource.size)),
      );
    }

    if (payload.length > MAX_LFL_OFFSET) {
      throw new Error(
        `Room ${number} would be ${payload.length} bytes after this edit, and a ` +
          `SCUMM v${version} index addresses a resource with a sixteen bit offset. ` +
          `Anything past ${MAX_LFL_OFFSET} cannot be pointed at, so the game would ` +
          `load and hand out the wrong bytes. Shorten the edit, or move what grew ` +
          `into a room with room to spare.`,
      );
    }

    moved.set(number, offsets);
    rebuilt.set(number, new Uint8Array(payload));
  }

  return { index: rewriteLflIndex(index, moved, version), rooms: rebuilt };
}

/**
 * Rewrites the index's directory offsets to where their resources moved.
 *
 * The whole index is one record rather than a series of blocks, so it is walked
 * in order and re-emitted in order — there is no tag to skip on. The room
 * directory is walked like the rest and rewritten like the rest, because unlike
 * v4's it has no disk-number column to preserve: a v3 room is its own file and
 * the directory's offsets are zero.
 */
function rewriteLflIndex(
  index: Uint8Array,
  moved: Map<number, Map<number, number>>,
  version: 2 | 3,
): Uint8Array {
  const out = index.slice();
  let at = 2; // past the magic word

  const objects = readU16LE(out, at);
  at += 2 + objects * (version >= 3 ? 4 : 1);

  // Rooms, costumes, scripts, sounds — in that order, always four of them.
  for (let list = 0; list < 4; list++) {
    if (at >= out.length) break;
    const count = out[at];
    at += 1;

    const isRooms = list === 0;
    const roomsAt = at;
    if (!isRooms) at += count;

    for (let i = 0; i < count; i++) {
      const entry = at + i * 2;
      const room = isRooms ? i : out[roomsAt + i];
      const offset = readU16LE(out, entry);
      // 0xFFFF is "not present" and stays that way; an offset the map does not
      // know is one whose room was not rebuilt, and inventing a new one for it
      // would be worse than leaving it.
      if (offset === 0xffff) continue;
      const next = moved.get(room)?.get(offset);
      if (next === undefined) continue;
      out[entry] = next & 0xff;
      out[entry + 1] = (next >> 8) & 0xff;
    }
    at += count * 2;
  }

  return out;
}

/**
 * The file name a room's data belongs in.
 *
 * Two digits, zero-padded, which is the whole of the v2 and v3 naming rule and
 * the reason a room's number never has to be stored anywhere: `01.LFL` *is*
 * room 1.
 */
export function lflRoomFileName(room: number): string {
  return `${String(room).padStart(2, '0')}.LFL`;
}
