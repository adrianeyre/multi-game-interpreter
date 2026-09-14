import { iterateChunks, readChunkHeader } from '../engine/resource/Chunk.js';
import { decryptCopy } from '../engine/resource/xor.js';
import { readU16LE, readU32LE } from '../engine/util/ByteStream.js';

/**
 * Writes a published game back out, with some of its scripts replaced.
 *
 * This is the other way of producing a game, and it is not the compiler. The
 * compiler builds a game from a project — from intent — and emits v5 bytecode.
 * This one starts from a game that already exists and changes part of it, which
 * is what editing an imported game actually means: everything the author did
 * not touch has to come out exactly as it went in, including the parts no
 * importer understands.
 *
 * That makes it version-agnostic, which is the useful surprise. It never asks
 * what a resource *is* — it copies chunks, substitutes the ones it was given,
 * and then rewrites every directory entry by looking up where that resource
 * moved to. A v6 game and a v5 game go through the same code, because the thing
 * being rewritten is the container, and the container did not change.
 *
 * Layout being rebuilt:
 *
 *   LECF                    the file
 *     LOFF                  room number -> file offset of its LFLF
 *     LFLF                  one disk block per room
 *       ROOM SCRP SOUN ...  resources, addressed by offset from the LFLF header
 *
 * A replaced script is almost never the same length as the one it replaces, so
 * every resource after it in its block moves, every later block moves, and both
 * `LOFF` and the index directories are wrong until they are rewritten. Doing
 * that by remembering old-offset -> new-offset per room means none of it
 * depends on knowing which entry addresses which kind of resource.
 */

export interface ScriptReplacement {
  /** Room whose block the script lives in. */
  room: number;
  /** Offset of the script's chunk header, relative to the LFLF header. */
  offset: number;
  /** The replacement chunk, header and all. */
  chunk: Uint8Array;
}

export interface ExportedGame {
  index: Uint8Array;
  data: Uint8Array;
}

/**
 * Directory blocks whose entries are (room, offset) pairs into a disk block.
 *
 * `DRSC` is v8's, for the `RMSC` blocks holding a room's scripts. Left out, a
 * v8 export rewrites every other directory and leaves that one pointing where
 * the scripts used to be — a game whose rooms draw and do nothing.
 */
const DIRECTORY_TAGS = new Set(['DROO', 'DSCR', 'DCOS', 'DCHR', 'DSOU', 'DRSC']);

/**
 * Rebuilds a game's two files with the given scripts replaced.
 *
 * Both files arrive decrypted and leave decrypted; encryption is the caller's,
 * since it already knows the key it read them with.
 */
export function rewriteGame(
  index: Uint8Array,
  data: Uint8Array,
  replacements: ScriptReplacement[],
  /**
   * Thirty-two bits per directory count at v8, sixteen everywhere else.
   *
   * The entries themselves are already 32-bit offsets in every Version this
   * writer covers; what v8 widened is the *count* in front of them. Rewriting
   * a v8 directory with the narrow count writes two bytes where four belong
   * and pushes every entry after it two along, which is a game that loads and
   * hands out the wrong resources.
   */
  wideCounts = false,
): ExportedGame {
  const byRoom = new Map<number, Map<number, Uint8Array>>();
  for (const replacement of replacements) {
    const room = byRoom.get(replacement.room) ?? new Map<number, Uint8Array>();
    room.set(replacement.offset, replacement.chunk);
    byRoom.set(replacement.room, room);
  }

  const lecf = readChunkHeader(data, 0);
  if (lecf.tag !== 'LECF') throw new Error('Not a SCUMM data file (no LECF block)');

  const loff = findDirectChunk(data, lecf, 'LOFF');
  if (!loff) throw new Error('Not a SCUMM data file (no LOFF block)');

  // LOFF as the input wrote it: a count, then one (room, file offset) pair
  // each. Kept as a list rather than only as a lookup because the entries are
  // re-emitted in the order they arrived in, which is not necessarily the
  // order the blocks appear in the file.
  const loffEntries: Array<{ room: number; storedOffset: number }> = [];
  const roomOfBlock = new Map<number, number>();
  const roomCount = data[loff.dataOffset];
  for (let i = 0; i < roomCount; i++) {
    const at = loff.dataOffset + 1 + i * 5;
    const storedOffset = readU32LE(data, at + 1);
    loffEntries.push({ room: data[at], storedOffset });
    roomOfBlock.set(storedOffset, data[at]);
  }

  /**
   * How far past its `LFLF` header a LOFF entry points, in this release.
   *
   * There are two conventions in the wild and this writer used to know only
   * one. It assumed a LOFF offset was the `LFLF` chunk's own position, which
   * is what the fixtures encode — and Fate of Atlantis and Day of the Tentacle
   * both point eight bytes further on, at the `ROOM` block inside it. So every
   * lookup missed, every room in a re-exported container came out numbered
   * 255, and every offset was eight bytes short.
   *
   * `ResourceManager.roomNumberForOffset` already matched *either* convention
   * when reading, which is why nothing noticed: the games loaded, and the
   * writer's disagreement with them only showed up in the bytes. Reproducing
   * whichever the input used is the whole fix — this is not a choice between
   * two readings of the format, it is a property of the file in hand.
   */
  let loffBias = 0;

  /** room -> (old resource offset -> new resource offset), both from the LFLF. */
  const moved = new Map<number, Map<number, number>>();
  const blocks: Array<{ room: number; bytes: Uint8Array }> = [];

  for (const block of iterateChunks(data, lecf.dataOffset, lecf.dataOffset + lecf.dataSize)) {
    if (block.tag !== 'LFLF') continue;

    let room = roomOfBlock.get(block.offset);
    if (room === undefined && roomOfBlock.has(block.dataOffset)) {
      room = roomOfBlock.get(block.dataOffset);
      loffBias = block.dataOffset - block.offset;
    }
    if (room === undefined) room = -1;
    const substitutions = byRoom.get(room);
    const offsets = new Map<number, number>();

    const payload = new Bytes();
    for (const resource of iterateChunks(data, block.dataOffset, block.offset + block.size)) {
      const oldOffset = resource.offset - block.offset;
      // The new offset is where this resource lands in the block being built,
      // past the header the block will get.
      offsets.set(oldOffset, payload.length + 8);

      const replacement = substitutions?.get(oldOffset);
      const bytes = replacement ?? data.subarray(resource.offset, resource.offset + resource.size);
      payload.append(bytes);
    }

    moved.set(room, offsets);
    blocks.push({ room, bytes: payload.toBytes() });
  }

  // LOFF is a fixed size, so the file offsets can be laid out before the blocks
  // are written: the header, then LOFF itself, then each block in order.
  const loffSize = 8 + 1 + blocks.length * 5;
  let at = 8 + loffSize;
  const fileOffsets: number[] = [];
  for (const block of blocks) {
    fileOffsets.push(at + loffBias);
    at += block.bytes.length + 8;
  }

  /** Room number -> where its entry should now point. */
  const newOffsets = new Map<number, number>();
  blocks.forEach((block, i) => newOffsets.set(block.room, fileOffsets[i]));

  // In the order the input listed them. A game whose LOFF is sorted by room
  // and whose blocks are laid out the same way cannot tell the difference;
  // one where they disagree comes back reordered if this follows the blocks.
  const written =
    loffEntries.length === blocks.length && loffEntries.every((entry) => newOffsets.has(entry.room))
      ? loffEntries.map((entry) => ({ room: entry.room, offset: newOffsets.get(entry.room)! }))
      : blocks.map((block, i) => ({ room: block.room, offset: fileOffsets[i] }));

  const loffPayload = new Bytes();
  loffPayload.push(written.length);
  for (const entry of written) {
    loffPayload.push(entry.room & 0xff, ...u32le(entry.offset));
  }

  const body = new Bytes();
  body.append(chunk('LOFF', loffPayload.toBytes()));
  for (const block of blocks) body.append(chunk('LFLF', block.bytes));

  return { index: rewriteIndex(index, moved, wideCounts), data: chunk('LECF', body.toBytes()) };
}

/**
 * Rewrites the index's directory offsets to where their resources moved.
 *
 * Every other index block — room names, the limits, the global object table,
 * the array declarations — is copied through untouched. None of it addresses
 * the data file, so none of it can be wrong after a rewrite, and copying beats
 * regenerating precisely because this code does not understand most of it.
 */
function rewriteIndex(
  index: Uint8Array,
  moved: Map<number, Map<number, number>>,
  wideCounts: boolean,
): Uint8Array {
  const out = new Bytes();
  const countBytes = wideCounts ? 4 : 2;

  for (const block of iterateChunks(index, 0)) {
    if (!DIRECTORY_TAGS.has(block.tag)) {
      out.append(index.subarray(block.offset, block.offset + block.size));
      continue;
    }

    const count = wideCounts
      ? readU32LE(index, block.dataOffset)
      : readU16LE(index, block.dataOffset);
    const rooms: number[] = [];
    for (let i = 0; i < count; i++) rooms.push(index[block.dataOffset + countBytes + i]);

    const payload = new Bytes();
    payload.push(...(wideCounts ? u32le(count) : u16le(count)), ...rooms);
    for (let i = 0; i < count; i++) {
      const offset = readU32LE(index, block.dataOffset + countBytes + count + i * 4);
      // An entry pointing nowhere stays pointing nowhere; a resource whose
      // offset is not in the map was not in the container to begin with, and
      // inventing a new offset for it would be worse than leaving it.
      const next = moved.get(rooms[i])?.get(offset);
      payload.push(...u32le(next ?? offset));
    }

    out.append(chunk(block.tag, payload.toBytes()));
  }

  return out.toBytes();
}

/**
 * Rebuilds a `ROOM` resource with some of the scripts inside it replaced.
 *
 * A room's entry, exit and local scripts are not resources of their own — they
 * are chunks *inside* the room, so changing one means rebuilding the room and
 * substituting the whole thing. Nothing inside a room addresses another part of
 * it by stored offset (object images and verb code are found by scanning when
 * the room is parsed), so re-emitting the chunks in order with one swapped is
 * safe even though the ones after it move.
 */
export function replaceRoomScripts(
  room: Uint8Array,
  replacements: Map<number, Uint8Array>,
): Uint8Array {
  const header = readChunkHeader(room, 0);
  // `RMSC` as well as `ROOM`, because at v8 a room's scripts are in the
  // sibling block rather than in the room — and this rebuilds whichever of the
  // two it was handed, under its own tag.
  if (header.tag !== 'ROOM' && header.tag !== 'RMSC') throw new Error('Not a room resource');

  const payload = new Bytes();
  for (const child of iterateChunks(room, header.dataOffset, header.offset + header.size)) {
    const replacement = replacements.get(child.offset);
    payload.append(replacement ?? room.subarray(child.offset, child.offset + child.size));
  }

  return chunk(header.tag, payload.toBytes());
}

/**
 * Builds the replacement chunk for one edited script.
 *
 * The chunk keeps its tag and whatever its payload carried before the code —
 * `LSCR`'s script number — and only the code changes. Its size field is
 * rewritten, since that is the one part of a chunk that is not simply copied.
 */
export function rebuildScriptChunk(
  room: Uint8Array,
  chunkOffset: number,
  prefix: number,
  code: Uint8Array,
): Uint8Array {
  const header = readChunkHeader(room, chunkOffset);
  const payload = new Bytes();
  payload.append(room.subarray(header.dataOffset, header.dataOffset + prefix));
  payload.append(code);
  return chunk(header.tag, payload.toBytes());
}

/**
 * Writes an edited project back over the game it was imported from.
 *
 * This is what "edit an imported game" finally means. The project supplies the
 * changed scripts and nothing else: art, geometry, sound and every resource no
 * importer understands come from the original files, untouched, because the
 * project is not a complete description of the game and never claimed to be.
 *
 * Only scripts carrying an `origin` are considered — those are the ones the
 * importer read out of this game and can therefore put back. An authored action
 * added in the editor has no origin, and is not written: mixing v5 bytecode
 * into a v6 game would produce something no interpreter can run, which is what
 * `describeUnbuildableTarget` refuses at the other door.
 */
export function exportEditedGame(
  index: Uint8Array,
  data: Uint8Array,
  scripts: EditedScript[],
  /**
   * The Version, for the two things about this container that are not
   * version-agnostic after all: v8 counts a directory's entries in thirty-two
   * bits, and keeps a room's scripts in a `RMSC` block beside the `ROOM`
   * rather than inside it.
   */
  version = 5,
): ExportedGame {
  const wideCounts = version >= 8;
  const scriptsTag = version >= 8 ? 'RMSC' : 'ROOM';
  if (scripts.length === 0) return rewriteGame(index, data, [], wideCounts);

  const lecf = readChunkHeader(data, 0);
  const loff = findDirectChunk(data, lecf, 'LOFF');
  if (lecf.tag !== 'LECF' || !loff) throw new Error('Not a SCUMM data file');

  // Where each room's disk block starts, so a room resource can be found.
  const blockOfRoom = new Map<number, number>();
  const roomCount = data[loff.dataOffset];
  for (let i = 0; i < roomCount; i++) {
    const at = loff.dataOffset + 1 + i * 5;
    blockOfRoom.set(data[at], readU32LE(data, at + 1));
  }

  const byRoom = new Map<number, EditedScript[]>();
  for (const script of scripts) {
    byRoom.set(script.room, [...(byRoom.get(script.room) ?? []), script]);
  }

  const replacements: ScriptReplacement[] = [];

  for (const [room, edits] of byRoom) {
    const blockAt = blockOfRoom.get(room);
    if (blockAt === undefined) continue;

    const block = readChunkHeader(data, blockAt);
    const roomChunk = findDirectChunk(data, block, scriptsTag);
    if (!roomChunk) continue;

    const roomBytes = data.subarray(roomChunk.offset, roomChunk.offset + roomChunk.size);

    const inside = new Map<number, Uint8Array>();
    for (const edit of edits) {
      inside.set(
        edit.chunkOffset,
        rebuildScriptChunk(roomBytes, edit.chunkOffset, edit.prefix, edit.code),
      );
    }

    replacements.push({
      room,
      offset: roomChunk.offset - block.offset,
      chunk: replaceRoomScripts(roomBytes, inside),
    });
  }

  return rewriteGame(index, data, replacements, wideCounts);
}

/** One script an author changed, addressed as the importer recorded it. */
export interface EditedScript {
  room: number;
  /** Offset of the script's chunk header within the room resource. */
  chunkOffset: number;
  /** Payload bytes before the code — `LSCR`'s script number. */
  prefix: number;
  code: Uint8Array;
}

/** Reads a game back for a caller that has only the encrypted files. */
export function decryptGame(index: Uint8Array, data: Uint8Array, key: number) {
  return { index: decryptCopy(index, key), data: decryptCopy(data, key) };
}

function findDirectChunk(
  data: Uint8Array,
  parent: { dataOffset: number; dataSize: number },
  tag: string,
) {
  for (const child of iterateChunks(data, parent.dataOffset, parent.dataOffset + parent.dataSize)) {
    if (child.tag === tag) return child;
  }
  return undefined;
}

/**
 * A growing run of bytes, appended to rather than spread into.
 *
 * The reason this exists rather than a `number[]` is a crash on real data.
 * Every accumulator here used to be an array of numbers filled with
 * `payload.push(...bytes)` and `[...block.bytes]`, which is fine for a fixture
 * and fatal for a game: a spread passes every element as an argument, so a
 * single `LFLF` block of a few hundred kilobytes exceeds the call stack.
 * Fate of Atlantis is 9MB in one container and could not be exported at all;
 * Loom CD could, because `lec-disks` writes its blocks a different way.
 *
 * Nothing here is clever. It keeps the pieces and joins them once, which also
 * stops a 9MB file being held as nine million boxed numbers on the way out.
 */
class Bytes {
  private readonly parts: Uint8Array[] = [];
  private pending: number[] = [];
  private total = 0;

  /** A few bytes known individually — a size field, a room number. */
  push(...values: number[]): void {
    this.pending.push(...values);
    this.total += values.length;
  }

  /** A run of bytes of any length, which is the case that must not spread. */
  append(bytes: Uint8Array): void {
    this.flush();
    this.parts.push(bytes);
    this.total += bytes.length;
  }

  get length(): number {
    return this.total;
  }

  toBytes(): Uint8Array {
    this.flush();
    const out = new Uint8Array(this.total);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    this.parts.push(Uint8Array.from(this.pending));
    this.pending = [];
  }
}

function chunk(tag: string, payload: Uint8Array): Uint8Array {
  const size = payload.length + 8;
  const out = new Uint8Array(size);
  for (let index = 0; index < tag.length; index++) out[index] = tag.charCodeAt(index);
  out[4] = (size >> 24) & 0xff;
  out[5] = (size >> 16) & 0xff;
  out[6] = (size >> 8) & 0xff;
  out[7] = size & 0xff;
  out.set(payload, 8);
  return out;
}

function u16le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}
