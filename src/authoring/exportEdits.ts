import {
  SMALL_CHUNKS,
  findChunk,
  iterateChunks,
  readChunkHeader,
  readSmallChunkHeader,
} from '../engine/resource/Chunk.js';
import type { ResourceLayout } from '../engine/resource/GameDetector.js';
import { decryptCopy } from '../engine/resource/xor.js';
import {
  exportEditedGame,
  rewriteGame,
  type EditedScript,
  type ExportedGame,
} from './exportGame.js';
import {
  rebuildSmallScriptBlock,
  replaceSmallRoomScripts,
  rewriteLecGame,
  roomBlockOffset,
  smallChunk,
} from './exportLecGame.js';
import { lflRoomFileName, rewriteLflGame } from './exportLflGame.js';
import { encodeSmallImage, type IndexedImage } from './ImageEncoder.js';
import type { ArtOrigin } from './project.js';
import { RoomGraphics } from '../engine/gfx/RoomGraphics.js';

/**
 * One entry point over three writers, chosen by Resource layout.
 *
 * `CONTEXT.md` says it in one line — *one writer per layout, and one principle
 * across all three: copy what was not touched, substitute what was, rebuild
 * the index* — and this is where that stops being a sentence and becomes a
 * switch. The three writers already existed and nothing above them could reach
 * two of them: the editor's export path knew only `LECF`, so a v4, v3 or v2
 * game imported, decompiled, edited and then had nowhere to go.
 *
 * What each layout costs an exporter is not the same shape of problem:
 *
 * - **`lecf-container`** — one file, one directory of rooms. A resource that
 *   grows moves everything after it, so `LOFF` and every directory entry are
 *   rewritten.
 * - **`lec-disks`** — an index plus up to nine `DISKnn.LEC`. The same, once
 *   per disk, with two-character tags and little-endian sizes, and with
 *   directory offsets counted from the `RO` block rather than from the `LF`
 *   around it.
 * - **`lfl-rooms`** — an index and one file per room. Nothing moves at all: a
 *   resource that grows makes *its own file* bigger and leaves every other
 *   file byte for byte as it was. The index's sixteen-bit offsets are the
 *   constraint instead, and the writer refuses rather than truncating one.
 *
 * Everything here arrives decrypted and leaves encrypted, because the caller
 * writing files out wants files a player can open, and the key is a property
 * of the layout rather than of the edit.
 */

/** The published files an edited game is written back over. */
export interface EditableSource {
  layout: ResourceLayout;
  version: number;
  indexFile: string;
  /** Decrypted index. */
  index: Uint8Array;
  /** Decrypted data files, named and in the order the reader read them. */
  dataFiles: Array<{ name: string; data: Uint8Array }>;
  /**
   * The charset files the pre-v5 layouts keep outside the data, as read.
   *
   * Copied through rather than rewritten — nothing addresses them by offset,
   * so there is nothing in them an export could invalidate. They are here
   * because an export that leaves them out is not the game: a v4 install is
   * `000.LFL`, its disks *and* `901.LFL`–`904.LFL`, and writing the first two
   * produced something that loaded and could not draw a letter.
   *
   * Empty for `lecf-container`, whose charsets are resources inside it.
   */
  charsetFiles?: Array<{ name: string; data: Uint8Array }>;
  xorKey: number;
  dataXorKey: number;
}

/**
 * One picture an author may have changed, addressed as the importer recorded
 * it.
 *
 * "May have": whether it *was* changed is decided here rather than by the
 * editor, by decoding the block that is already there and comparing pixels. An
 * image that decodes to what it decoded to before is written back as the bytes
 * it arrived as, which is what keeps byte-identity a property of unmodified
 * resources — an encoder that is *correct* does not have to be Lucasfilm's,
 * and re-encoding everything would make every export differ from its input.
 */
export interface EditedArt extends ArtOrigin {
  image: IndexedImage;
}

/** A file to write out, encrypted the way the game expects to find it. */
export interface ExportedFile {
  name: string;
  data: Uint8Array;
}

/**
 * Writes a game back out with an author's script edits in it.
 *
 * The files come back encrypted and named, which is the whole of what a caller
 * has to know: which layout it was and which key each file wants are decided
 * here rather than at every download button.
 */
export function exportEditedFiles(
  source: EditableSource,
  scripts: readonly EditedScript[],
  /**
   * Edited pictures, for the layouts whose art is one substitutable block.
   *
   * Ignored by the container path: a v5 or later picture is a `SMAP` inside an
   * `IM00` inside an `RMIM`, and writing one back is a rebuild of that nesting
   * rather than a substitution. Nothing in the v2–v8 widening asks for it, and
   * silently accepting the argument and dropping it would be worse than not
   * taking one.
   */
  art: readonly EditedArt[] = [],
): ExportedFile[] {
  if (source.layout === 'lecf-container') return exportContainer(source, scripts);
  if (source.layout === 'lec-disks')
    return withCharsets(exportLecDisks(source, scripts, art), source);
  return withCharsets(exportLflRooms(source, scripts, art), source);
}

/**
 * The charsets, unchanged, appended to whatever the layout's writer produced.
 *
 * A separate step rather than part of each writer because it is the same step:
 * they are not rewritten, they are carried.
 */
function withCharsets(files: ExportedFile[], source: EditableSource): ExportedFile[] {
  const charsets = source.charsetFiles ?? [];
  if (charsets.length === 0) return files;
  return [...files, ...charsets.map((file) => ({ name: file.name, data: file.data }))];
}

function exportContainer(source: EditableSource, scripts: readonly EditedScript[]): ExportedFile[] {
  const data = source.dataFiles[0]?.data ?? new Uint8Array(0);
  const rewritten: ExportedGame =
    scripts.length === 0
      ? rewriteGame(source.index, data, [], source.version >= 8)
      : exportEditedGame(source.index, data, [...scripts], source.version);

  return [
    { name: source.indexFile, data: decryptCopy(rewritten.index, source.xorKey) },
    {
      name: source.dataFiles[0]?.name ?? source.indexFile.replace(/0$/, '1'),
      data: decryptCopy(rewritten.data, source.dataXorKey),
    },
  ];
}

/**
 * v4: rebuild each edited room's `RO` block, then hand it to the disk writer.
 *
 * A room's entry, exit and local scripts are chunks *inside* `RO` rather than
 * resources of their own, so an edit to one is a replacement of the whole
 * room — the same shape the `LECF` path has, in the other chunk format.
 */
function exportLecDisks(
  source: EditableSource,
  scripts: readonly EditedScript[],
  art: readonly EditedArt[],
): ExportedFile[] {
  const disks = source.dataFiles.map((file) => file.data);
  const replacements = classicReplacements(scripts, art, (room) =>
    findRoomBlockInDisks(disks, room),
  ).map(({ room, block }) => ({
    room,
    // The index addresses a room's resources from the `RO` block, and the `RO`
    // block is at zero from itself.
    offset: 0,
    block,
  }));

  const rewritten = rewriteLecGame(source.index, disks, replacements);

  return [
    { name: source.indexFile, data: decryptCopy(rewritten.index, source.xorKey) },
    ...rewritten.disks.map((disk, i) => ({
      name: source.dataFiles[i].name,
      data: decryptCopy(disk, source.dataXorKey),
    })),
  ];
}

/**
 * v2 and v3: rebuild the edited rooms' files, and copy every other one.
 *
 * The copy is the point. Every file this export does not touch comes out of
 * the other end as the same bytes it went in as, because nothing addresses
 * across a file boundary — which is what makes byte-identity for an unedited
 * export a property of the layout rather than of the writer's care.
 */
function exportLflRooms(
  source: EditableSource,
  scripts: readonly EditedScript[],
  art: readonly EditedArt[],
): ExportedFile[] {
  const rooms = new Map<number, Uint8Array>();
  const nameOf = new Map<number, string>();
  for (const file of source.dataFiles) {
    const room = roomNumberOfFile(file.name);
    if (room === null) continue;
    rooms.set(room, file.data);
    nameOf.set(room, file.name);
  }

  const replacements = classicReplacements(scripts, art, (room) => {
    const file = rooms.get(room);
    if (!file) return null;
    // The room's `RO` block, which is the first chunk of its file in every
    // release seen — found by walking rather than assumed at zero.
    for (const chunk of iterateChunks(file, 0, file.length, SMALL_CHUNKS)) {
      if (chunk.tag === 'RO')
        return {
          bytes: file.subarray(chunk.offset, chunk.offset + chunk.size),
          offset: chunk.offset,
        };
    }
    return null;
  }).map(({ room, block, offset }) => ({ room, offset, block }));

  const rewritten = rewriteLflGame(source.index, rooms, replacements, source.version <= 2 ? 2 : 3);

  return [
    { name: source.indexFile, data: decryptCopy(rewritten.index, source.xorKey) },
    ...[...rewritten.rooms.entries()]
      .sort(([a], [b]) => a - b)
      .map(([room, data]) => ({
        name: nameOf.get(room) ?? lflRoomFileName(room),
        data: decryptCopy(data, source.dataXorKey),
      })),
  ];
}

/** Where a room's `RO` block is, and what it holds. */
interface RoomBlock {
  bytes: Uint8Array;
  /** Offset of the block within the file or disk it was found in. */
  offset: number;
}

/**
 * Rebuilds one `RO` block per edited room, with its scripts substituted.
 *
 * Shared by the two pre-v5 layouts because the *room* is the same shape in
 * both: only where it sits differs, which is what the caller's lookup
 * answers.
 */
function classicReplacements(
  scripts: readonly EditedScript[],
  art: readonly EditedArt[],
  findRoom: (room: number) => RoomBlock | null,
): Array<{ room: number; block: Uint8Array; offset: number }> {
  const scriptsByRoom = new Map<number, EditedScript[]>();
  for (const script of scripts) {
    scriptsByRoom.set(script.room, [...(scriptsByRoom.get(script.room) ?? []), script]);
  }

  const artByRoom = new Map<number, EditedArt[]>();
  for (const picture of art) {
    artByRoom.set(picture.room, [...(artByRoom.get(picture.room) ?? []), picture]);
  }

  const out: Array<{ room: number; block: Uint8Array; offset: number }> = [];
  for (const room of new Set([...scriptsByRoom.keys(), ...artByRoom.keys()])) {
    const found = findRoom(room);
    if (!found) continue;

    const inside = new Map<number, Uint8Array>();
    for (const edit of scriptsByRoom.get(room) ?? []) {
      inside.set(
        edit.chunkOffset,
        rebuildSmallScriptBlock(found.bytes, edit.chunkOffset, edit.prefix, edit.code),
      );
    }
    for (const picture of artByRoom.get(room) ?? []) {
      const rebuilt = rebuildSmallImageBlock(found.bytes, picture);
      if (rebuilt) inside.set(picture.chunkOffset, rebuilt);
    }

    if (inside.size === 0) continue;
    out.push({ room, block: replaceSmallRoomScripts(found.bytes, inside), offset: found.offset });
  }
  return out;
}

/**
 * The replacement block for one edited picture, or null when it did not change.
 *
 * The comparison is on *pixels* rather than on bytes, which is the whole
 * design: an image is re-encoded only when it decodes to something other than
 * what the game had, so an untouched room comes back byte for byte and an
 * edited one comes back correct. Lucasfilm's compressor is not reproduced and
 * does not need to be (#199).
 */
function rebuildSmallImageBlock(room: Uint8Array, picture: EditedArt): Uint8Array | null {
  const header = readSmallChunkHeader(room, picture.chunkOffset);
  if (header.tag !== 'BM' && header.tag !== 'OI') return null;

  // A room's `BM` puts the strip table straight after its header; an object's
  // `OI` puts the object's id in between, and that id is carried through
  // rather than rebuilt.
  const idBytes = header.tag === 'OI' ? 2 : 0;
  const table = header.dataOffset + idBytes;

  const asItStands = new RoomGraphics(picture.image.width, picture.image.height, 0);
  try {
    asItStands.decodeSmallImage(
      room,
      table,
      0,
      0,
      picture.image.width,
      picture.image.height,
      picture.sixteenColour,
    );
  } catch {
    // A block this reader cannot decode is a block it has no business
    // rewriting: leaving it is the answer that cannot make things worse.
    return null;
  }

  if (samePixels(asItStands.background, picture.image.pixels)) return null;

  return new Uint8Array(
    smallChunk(header.tag, [
      ...room.subarray(header.dataOffset, header.dataOffset + idBytes),
      ...encodeSmallImage(picture.image, picture.sixteenColour),
    ]),
  );
}

function samePixels(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Finds a room's `RO` block across a set of `DISKnn.LEC` containers. */
function findRoomBlockInDisks(disks: readonly Uint8Array[], room: number): RoomBlock | null {
  for (const disk of disks) {
    const container = readSmallChunkHeader(disk, 0);
    if (container.tag !== 'LE') continue;

    for (const block of iterateChunks(
      disk,
      container.dataOffset,
      container.offset + container.size,
      SMALL_CHUNKS,
    )) {
      if (block.tag !== 'LF') continue;
      // `LF`'s payload opens with the room number, and the `RO` starts after
      // it — the same two bytes the index's offsets are counted past.
      if (disk[block.dataOffset] !== (room & 0xff)) continue;

      const at = block.offset + roomBlockOffset();
      const header = readSmallChunkHeader(disk, at);
      if (header.tag !== 'RO') continue;
      return { bytes: disk.subarray(header.offset, header.offset + header.size), offset: 0 };
    }
  }
  return null;
}

/** `01.LFL` -> 1. Null for a name that is not a room file. */
function roomNumberOfFile(name: string): number | null {
  const match = /^(\d{1,3})\.lfl$/i.exec(name.replace(/\\/g, '/').split('/').pop() ?? '');
  if (!match) return null;
  return Number(match[1]);
}

/** Re-exported so a caller can address a room's file without knowing the rule. */
export { lflRoomFileName, findChunk, readChunkHeader };
