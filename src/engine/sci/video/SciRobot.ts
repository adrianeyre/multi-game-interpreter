/**
 * Robot: pre-rendered actor footage that is **drawn into the scene, not played
 * at the screen**.
 *
 * `CONTEXT.md` is firm about the distinction and #226 exists to test it. SEQ,
 * VMD and DUK are SMUSH's situation — full-screen, played to the end or
 * skipped, nothing a Project reconstructs. A Robot is not one of those: in
 * Phantasmagoria the protagonist *is* a Robot, composited into a Plane with a
 * priority, moving over a static background and occluded by scenery.
 *
 * ## The claim this file settles
 *
 * ADR 0015 says one compositor. If a Robot frame composites through the same
 * `Plane`, the same `ScreenItem` and the same three sort keys as a View cel,
 * the claim is real. If it needs its own drawing path, the tripwire has fired
 * and the renderer should split rather than grow a flag.
 *
 * **It did not need one.** A Robot frame is a cel count and then cels: width,
 * height, a position, and a chunked body. `frameScreenItems` below hands back
 * `Omit<ScreenItem, 'order'>` values — the identical shape `drawCast` builds
 * for an actor — and nothing in `Plane` or `SciCompositor` was touched to make
 * that work. The one thing Robot brought is a **cel header of its own shape**:
 * 22 bytes rather than the 42 a V56 View and a cel Picture share. That is a
 * different way of writing down the same four facts, not a different way of
 * drawing them, and it is contained entirely in this file.
 *
 * ## Streaming, which is not optional
 *
 * A Robot's frame records are sized in a table near the front of the file, so
 * the frame a caller wants is one range read at a known offset. Nothing walks
 * the file. That is ADR 0021's seam doing the work it was put there for, and it
 * is what makes a 1 MB Robot and a 400 MB VMD the same problem.
 *
 * ## Audio is inside the frame, which is what keeps it in sync
 *
 * Each record is `videoSize` bytes of video followed by the rest as audio. The
 * audio for frame N is *in* frame N — not in a parallel stream with its own
 * clock — so sync is a property of the container rather than something this
 * code has to maintain. Sierra put it there for that reason.
 *
 * ## Verified against real data
 *
 * Every offset here was checked against Lighthouse's thirteen `.RBT` files.
 * The container is self-checking and it checks out exactly: for all thirteen,
 * the aligned frame-data offset plus the sum of the record sizes is the file
 * length to the byte. A frame is self-checking too — two bytes of cel count,
 * a 22-byte cel header and the cel's declared data size add up to the frame's
 * declared video size exactly.
 */

import type { VolumeReader } from '../../resource/VolumeReader.js';
import type { ScreenItem } from '../gfx/Plane.js';
import type { SciCel } from '../gfx/SciView.js';
import { lzs } from '../resource/sciCompression.js';

/** What the file says about itself, read once when it is opened. */
export interface SciRobotInfo {
  /** 5 or 6. The two differ in how wide the frame size table's entries are. */
  version: number;
  frameCount: number;
  /** Frames per second the game intended. */
  frameRate: number;
  hasPalette: boolean;
  /**
   * Whether frames carry audio, taken from the block size and not the flag.
   *
   * There is a byte at offset 25 that looks like the answer, and for two of
   * Lighthouse's thirteen Robots it is zero while the file plainly carries
   * audio — 184.RBT reserves a 40KB primer, declares a 2,772-byte audio block,
   * and hands back 238KB of it. The block size at offset 8 agrees with the
   * records every time: it is exactly the difference between a frame's record
   * size and its video size. So that is what is believed.
   */
  hasAudio: boolean;
  /** Bytes of audio in each frame's record, past the video. */
  audioBlockSize: number;
  /** The palette bytes, in the same layout every other SCI palette uses. */
  paletteAt: number;
  paletteSize: number;
  /** The most cels any one frame carries, which bounds a frame's cost. */
  maxCelsPerFrame: number;
}

/** One frame: its cels, and the audio that belongs with them. */
export interface SciRobotFrame {
  index: number;
  cels: Array<{ cel: SciCel; x: number; y: number }>;
  /**
   * The audio block for this frame, empty when there is none.
   *
   * Handed back rather than played here, for the reason the rest of this
   * project keeps sound behind a seam — but handed back *with the frame*,
   * because the two arriving together is the whole of the sync guarantee.
   */
  audio: Uint8Array;
}

export interface SciRobotStream {
  info: SciRobotInfo;
  /** One frame, read at its own offset. Nothing before it is touched. */
  frame(index: number): Promise<SciRobotFrame | null>;
  /** How many bytes have been read, for the memory accounting #226 asks for. */
  bytesRead(): number;
}

/**
 * The fixed header is 60 bytes, and the frame size table follows the palette.
 *
 * ScummVM reads this as six bytes of signature and then a 60-byte chunk, which
 * would put the table two bytes later. Lighthouse's files say otherwise, and
 * they say it thirteen times out of thirteen: the table sits at 60 plus the
 * palette size plus the primer's reserved size, and reading it two bytes late
 * produces sizes in the billions.
 */
const HEADER_SIZE = 60;

/**
 * After the two size tables come 256 cue times and 256 cue values.
 *
 * Sierra's own cue list, which this project does not use — a script asking
 * "which frame are we on" goes through the Kernel, not through here. Skipped
 * rather than read, but skipped by the right amount, because the frame data
 * that follows is aligned relative to the end of it.
 */
const CUE_BLOCK_SIZE = 256 * 4 + 256 * 2;

/** Frame data starts on a 2K boundary, which is a disc sector. */
const DATA_ALIGNMENT = 2048;

/** Cel count, then this many bytes per cel before the cel's own data. */
const CEL_HEADER_SIZE = 22;

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

function s16(bytes: Uint8Array, at: number): number {
  const value = u16(bytes, at);
  return value > 0x7fff ? value - 0x10000 : value;
}

function s32(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24);
}

/** True when these bytes open a Robot: a header size of 22, then `SOL\0`. */
export function isSciRobot(head: Uint8Array): boolean {
  return (
    head.length >= 6 &&
    u16(head, 0) === 0x16 &&
    head[2] === 0x53 &&
    head[3] === 0x4f &&
    head[4] === 0x4c &&
    head[5] === 0x00
  );
}

/**
 * Opens a Robot for frame-at-a-time reading.
 *
 * Two reads before any frame: the header, and the size table. Everything after
 * that is one range read per frame asked for. A 1 MB Robot costs about 1.6 KB
 * to open, and a Robot ten times the size costs the same plus its table.
 */
export async function openSciRobot(
  volumes: VolumeReader,
  file: string,
): Promise<SciRobotStream | null> {
  const header = await volumes.read(file, 0, HEADER_SIZE);
  if (!isSciRobot(header)) return null;
  let read = header.length;

  const version = u16(header, 6);
  const audioBlockSize = u16(header, 8);
  const frameCount = u16(header, 14);
  const paletteSize = u16(header, 16);
  const primerReservedSize = u16(header, 18);
  const hasPalette = header[24] !== 0;
  const frameRate = s16(header, 28);
  const maxCelsPerFrame = s16(header, 34);

  if (frameCount <= 0 || frameCount > 20000) return null;

  // Version 5 sizes its frames in 16 bits and version 6 in 32. That is the only
  // difference between them this project reads, and getting it the wrong way
  // round makes every offset after the first frame wrong — which shows up as a
  // cel count in the thousands rather than as an error.
  const wide = version >= 6;
  const tableAt = HEADER_SIZE + paletteSize + primerReservedSize;
  const tableSize = frameCount * (wide ? 8 : 4);
  const table = await volumes.read(file, tableAt, tableSize);
  read += table.length;
  if (table.length < tableSize) return null;

  const videoSizes: number[] = [];
  const recordSizes: number[] = [];
  for (let index = 0; index < frameCount; index++) {
    if (wide) {
      videoSizes.push(s32(table, index * 4));
      recordSizes.push(s32(table, frameCount * 4 + index * 4));
    } else {
      videoSizes.push(s16(table, index * 2));
      recordSizes.push(s16(table, frameCount * 2 + index * 2));
    }
  }

  const dataAt =
    Math.ceil((tableAt + tableSize + CUE_BLOCK_SIZE) / DATA_ALIGNMENT) * DATA_ALIGNMENT;

  // Where each frame starts, from the sizes rather than from a walk.
  const offsets: number[] = [dataAt];
  for (const size of recordSizes) offsets.push(offsets[offsets.length - 1] + size);

  const info: SciRobotInfo = {
    version,
    frameCount,
    frameRate,
    hasPalette,
    hasAudio: audioBlockSize > 0,
    audioBlockSize,
    // **After the primer, not before it.** Both orders read as a palette for
    // the six Robots with no primer, and only this one reads as a palette for
    // the seven with one — the other lands inside 40KB of compressed audio and
    // reports 16,705 colours, or none at all.
    paletteAt: HEADER_SIZE + primerReservedSize,
    paletteSize,
    maxCelsPerFrame,
  };

  return {
    info,
    bytesRead: () => read,
    async frame(index: number): Promise<SciRobotFrame | null> {
      if (index < 0 || index >= frameCount) return null;
      const record = await volumes.read(file, offsets[index], recordSizes[index]);
      read += record.length;
      if (record.length === 0) return null;

      const videoSize = Math.min(videoSizes[index], record.length);
      return {
        index,
        cels: readRobotCels(record.subarray(0, videoSize)),
        audio: record.subarray(videoSize),
      };
    },
  };
}

/**
 * The cels in one frame's video block.
 *
 * A count, then a 22-byte header and a body each. The header is not the 42-byte
 * record a View and a Picture share — Robot writes the same facts differently —
 * and the body is a run of chunks rather than one stream, because a Robot frame
 * is assembled from pieces that compress separately.
 */
export function readRobotCels(video: Uint8Array): Array<{ cel: SciCel; x: number; y: number }> {
  if (video.length < 2) return [];
  const count = u16(video, 0);
  // A count larger than any frame could hold is a frame read at the wrong
  // offset. Refused rather than looped over, so a bad offset says so instead of
  // allocating until it stops.
  if (count === 0 || count > 64) return [];

  const cels: Array<{ cel: SciCel; x: number; y: number }> = [];
  let at = 2;

  for (let index = 0; index < count; index++) {
    if (at + CEL_HEADER_SIZE > video.length) break;

    const width = s16(video, at + 2);
    const height = s16(video, at + 4);
    const x = s16(video, at + 10);
    const y = s16(video, at + 12);
    const dataSize = u16(video, at + 14);
    const chunkCount = s16(video, at + 16);
    at += CEL_HEADER_SIZE;

    if (width <= 0 || height <= 0 || width > 2048 || height > 2048) break;
    if (at + dataSize > video.length) break;

    const pixels = readRobotCelBody(video.subarray(at, at + dataSize), chunkCount, width * height);
    at += dataSize;

    cels.push({
      cel: {
        width,
        height,
        displaceX: 0,
        displaceY: 0,
        // Robot's own transparent index. Every Lighthouse Robot uses it, and it
        // is what lets an actor be an actor rather than a rectangle.
        clearKey: 0xff,
        pixels,
      },
      x,
      y,
    });
  }

  return cels;
}

/**
 * A cel body: `chunkCount` chunks, each ten bytes of header and then data.
 *
 * Compression `0` is STACpack, which this project already reads for SCI32
 * resources, and `2` is stored. A chunk in a method neither of those names is
 * left as the transparent index rather than copied through — a wrong guess here
 * is a band of noise across an actor, which is the fault class that looks like
 * bad artwork rather than like a bug.
 *
 * `chunkCount` of zero means the body is simply the pixels.
 */
function readRobotCelBody(body: Uint8Array, chunkCount: number, size: number): Uint8Array {
  const pixels = new Uint8Array(size).fill(0xff);
  if (chunkCount <= 0) {
    pixels.set(body.subarray(0, Math.min(body.length, size)));
    return pixels;
  }

  let at = 0;
  let written = 0;
  for (let chunk = 0; chunk < chunkCount && written < size; chunk++) {
    if (at + 10 > body.length) break;
    const packedSize = s32(body, at) >>> 0;
    const unpackedSize = s32(body, at + 4) >>> 0;
    const method = u16(body, at + 8);
    at += 10;
    if (at + packedSize > body.length) break;

    const packed = body.subarray(at, at + packedSize);
    at += packedSize;

    const room = Math.min(unpackedSize, size - written);
    if (method === 2) {
      pixels.set(packed.subarray(0, room), written);
    } else if (method === 0) {
      pixels.set(lzs(packed, unpackedSize).subarray(0, room), written);
    }
    written += unpackedSize;
  }

  return pixels;
}

/**
 * A frame's cels as screen items, ready for a Plane.
 *
 * **This function is the answer to #226's question.** It builds the same shape
 * `drawCast` builds for an actor, and hands it to the same `Plane.add`. Nothing
 * about Robot reaches the compositor: not a format, not a flag, not a second
 * path. If this had needed one, the right change would have been to split the
 * renderer rather than to add a branch — and it did not.
 */
export function frameScreenItems(
  frame: SciRobotFrame,
  priority: number,
  origin: { x: number; y: number } = { x: 0, y: 0 },
): Array<Omit<ScreenItem, 'order'>> {
  return frame.cels.map((placed) => ({
    cel: placed.cel,
    x: origin.x + placed.x,
    y: origin.y + placed.y,
    priority,
    visible: true,
  }));
}
