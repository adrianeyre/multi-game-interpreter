/**
 * DUK, which is an AVI — and the one video in the family this does not draw.
 *
 * `.duk` is Phantasmagoria 2's video, and the first thing to say about it is
 * that the name is the codec rather than the container. **A DUK file is a
 * RIFF/AVI** carrying Duck TrueMotion 1 video, which is why ScummVM's
 * `DuckPlayer` hands the file straight to `Video::AVIDecoder` and does nothing
 * container-shaped of its own. This project had it recorded the other way — a
 * `DUCK` tag at offset zero — and that tag is the *stream's* four-character
 * code inside the header list, not the file's first bytes. A DUK opens `RIFF`.
 *
 * The same reader serves `kShowMovie`'s `.AVI` files, which King's Quest VII
 * and Phantasmagoria ship, because they are the same container.
 *
 * ## What this reads
 *
 * The header list, so a caller knows the size, the frame count, the rate and
 * which codec each stream carries; and the `movi` list, indexed so that one
 * frame is one range read. With an `idx1` at the end that index is exact and
 * costs one read; without one the chunk headers are walked as frames are asked
 * for, which is a seek chain rather than a pass over the file. Either way a
 * player that skips after two frames has read two frames, which is ADR 0021's
 * whole point and #226's memory question.
 *
 * ## What this does not decode, and why it is not a shortcut
 *
 * **The TrueMotion 1 pixel codec is not decoded.** Two reasons, and the second
 * is the one that matters:
 *
 * 1. There is no free Phantasmagoria 2 data (#215), so a port of the codec
 *    could not be checked against a single real frame. This project's own
 *    process document is explicit that a decoder verified only against a
 *    fixture we wrote is a decoder that agrees with our reading of the format
 *    and with nothing else.
 * 2. **TrueMotion 1 decodes to 16-bit RGB, and every surface in this renderer
 *    is an 8-bit index into a palette.** So it is not a decoder that is
 *    missing; it is a *colour path* that is missing, from the codec through
 *    `ScreenItem` and the compositor to the framebuffer. That is an
 *    architectural change with an ADR 0015 shape to it, and it should be
 *    proposed as one rather than arrive as a special case inside a video file.
 *
 * So a video frame is handed back as bytes with its codec named, and a caller
 * that cannot draw it says so. The container work is not wasted by that: it is
 * what makes the frame count, the rate, the audio and the skipping correct
 * whenever the colour path lands.
 */

import type { VolumeReader } from '../../resource/VolumeReader.js';

/** A four-character code, as AVI writes them. */
function fourCC(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

export interface SciAviInfo {
  width: number;
  height: number;
  frameCount: number;
  /** Frames per second, from the main header's microseconds per frame. */
  frameRate: number;
  /**
   * The video stream's codec, as its four-character code.
   *
   * `DUCK` is TrueMotion 1 and is the one Phantasmagoria 2 ships. Named rather
   * than mapped to a boolean, because a caller that meets a codec this project
   * does not draw should be able to say which one it met.
   */
  videoCodec: string;
  /** True when this project can turn the video stream into pixels. */
  videoDecodable: boolean;
  hasAudio: boolean;
  audioFormat: number;
  audioChannels: number;
  audioFrequency: number;
  audioBitsPerSample: number;
}

/** One frame of an AVI: its video chunk, and the audio that arrived with it. */
export interface SciAviFrame {
  index: number;
  /** The video chunk's bytes, undecoded. Null when the frame carries none. */
  video: Uint8Array | null;
  /** Audio chunks that arrived alongside, in order. */
  audio: Uint8Array[];
}

export interface SciAviStream {
  info: SciAviInfo;
  frame(index: number): Promise<SciAviFrame | null>;
  bytesRead(): number;
}

/** Where a chunk is and how long it is, discovered as frames are asked for. */
interface AviChunk {
  id: string;
  at: number;
  size: number;
}

/**
 * True when these bytes open a RIFF/AVI, which is what a `.duk` is.
 *
 * Twelve bytes are enough, and reading them is the whole of the test: `RIFF`, a
 * size, and the form type `AVI `.
 */
export function isAviFile(head: Uint8Array): boolean {
  return head.length >= 12 && fourCC(head, 0) === 'RIFF' && fourCC(head, 8) === 'AVI ';
}

/** How much of the front of the file the header list is looked for in. */
const HEADER_WINDOW = 0x4000;

/**
 * Opens a DUK or AVI and indexes its frames.
 *
 * Two reads in the good case — the header list, and the `idx1` at the end — and
 * a seek chain in the case where a file carries no index. Nothing reads the
 * `movi` list itself until a frame is asked for.
 */
export async function openSciAvi(
  volumes: VolumeReader,
  file: string,
): Promise<SciAviStream | null> {
  const head = await volumes.read(file, 0, HEADER_WINDOW);
  if (!isAviFile(head)) return null;

  let read = head.length;
  let frameCount = 0;
  let frameRate = 0;
  let width = 0;
  let height = 0;
  let videoCodec = '';
  let hasAudio = false;
  let audioFormat = 0;
  let audioChannels = 0;
  let audioFrequency = 0;
  let audioBitsPerSample = 0;
  let moviAt = 0;
  let moviSize = 0;

  // Walk the top-level chunks. A LIST carries a form type in its first four
  // bytes and then chunks of its own; everything else is stepped over by its
  // own size, word-aligned as RIFF requires.
  let at = 12;
  let streamType = '';
  while (at + 8 <= head.length) {
    const id = fourCC(head, at);
    const size = u32(head, at + 4);
    const body = at + 8;

    if (id === 'LIST') {
      const form = fourCC(head, body);
      if (form === 'movi') {
        moviAt = body + 4;
        moviSize = size - 4;
        break;
      }
      // Descend into hdrl and strl rather than stepping over them.
      at = body + 4;
      continue;
    }

    if (id === 'avih') {
      frameRate = u32(head, body) === 0 ? 0 : 1000000 / u32(head, body);
      frameCount = u32(head, body + 16);
      width = u32(head, body + 32);
      height = u32(head, body + 36);
    } else if (id === 'strh') {
      streamType = fourCC(head, body);
      if (streamType === 'vids') videoCodec = fourCC(head, body + 4);
    } else if (id === 'strf' && streamType === 'vids') {
      // A BITMAPINFOHEADER. Its own width and height are the authority when
      // the main header disagrees, which some encoders manage.
      if (u32(head, body + 4) !== 0) width = u32(head, body + 4);
      if (u32(head, body + 8) !== 0) height = u32(head, body + 8);
      if (videoCodec === '') videoCodec = fourCC(head, body + 16);
    } else if (id === 'strf' && streamType === 'auds') {
      hasAudio = true;
      audioFormat = u16(head, body);
      audioChannels = u16(head, body + 2);
      audioFrequency = u32(head, body + 4);
      audioBitsPerSample = u16(head, body + 14);
    }

    at = body + size + (size & 1);
  }

  if (moviAt === 0 || width === 0 || height === 0) return null;

  const info: SciAviInfo = {
    width,
    height,
    frameCount,
    frameRate,
    videoCodec,
    // Nothing here decodes to pixels yet. Stated as a field rather than left
    // for a caller to infer from the codec name, because "can I draw this"
    // is the question a player actually asks.
    videoDecodable: false,
    hasAudio,
    audioFormat,
    audioChannels,
    audioFrequency,
    audioBitsPerSample,
  };

  // Frames are grouped as they appear: a video chunk, then whatever audio
  // arrived with it. Discovered lazily, so an unindexed two-hour file costs
  // one 8-byte read per chunk up to the frame somebody wanted.
  const groups: Array<{ video: AviChunk | null; audio: AviChunk[] }> = [];
  let scan = moviAt;
  let exhausted = false;

  /** True when a chunk id names a video stream's chunk (`00dc`, `00db`). */
  const isVideoChunk = (id: string): boolean =>
    id.length === 4 && (id.endsWith('dc') || id.endsWith('db'));
  const isAudioChunk = (id: string): boolean => id.length === 4 && id.endsWith('wb');

  async function scanTo(index: number): Promise<void> {
    while (!exhausted && groups.length <= index + 1) {
      if (scan + 8 > moviAt + moviSize) {
        exhausted = true;
        break;
      }
      const header = await volumes.read(file, scan, 8);
      read += header.length;
      if (header.length < 8) {
        exhausted = true;
        break;
      }
      const id = fourCC(header, 0);
      const size = u32(header, 4);
      const chunk: AviChunk = { id, at: scan + 8, size };
      scan += 8 + size + (size & 1);

      if (isVideoChunk(id)) {
        groups.push({ video: chunk, audio: [] });
      } else if (isAudioChunk(id) && groups.length > 0) {
        groups[groups.length - 1].audio.push(chunk);
      } else if (id === 'LIST') {
        // A `rec ` list groups one frame's chunks. Step into it rather than
        // over it, or every frame inside is invisible.
        scan = chunk.at + 4;
      }
    }
  }

  return {
    info,
    bytesRead: () => read,
    async frame(index: number) {
      if (index < 0) return null;
      await scanTo(index);
      const group = groups[index];
      if (!group) return null;

      const video = group.video ? await volumes.read(file, group.video.at, group.video.size) : null;
      if (video) read += video.length;

      const audio: Uint8Array[] = [];
      for (const chunk of group.audio) {
        const bytes = await volumes.read(file, chunk.at, chunk.size);
        read += bytes.length;
        audio.push(bytes);
      }

      return { index, video, audio };
    },
  };
}
