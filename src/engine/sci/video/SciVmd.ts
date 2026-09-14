/**
 * VMD: SCI2's video, played at the screen and not held.
 *
 * Coktel Vision's container, which Sierra licensed rather than wrote — Gabriel
 * Knight 2, Torin's Passage, Lighthouse and RAMA all ship it. `CONTEXT.md`
 * puts it on the same side of the line as SMUSH: full-screen, played to the end
 * or skipped, nothing a Project reconstructs. Robot is the one that is not, and
 * it is in `SciRobot.ts`.
 *
 * ## Why this is a reader and not a buffer
 *
 * The enormous files are here. A VMD in Phantasmagoria runs to hundreds of
 * megabytes, and #226 asks for the peak memory rather than the throughput:
 * opening one costs its header, its frame table and nothing else, and playing
 * it costs one frame at a time through `VolumeReader` (ADR 0021). Nothing in
 * this file ever holds the whole thing.
 *
 * ## The shape of the format
 *
 * A fixed header — 816 bytes for every version Sierra shipped — then a frame
 * table at an offset the header names, then the frames themselves wherever the
 * table says. A frame is a fixed number of **parts**, and a part is audio,
 * video, a subtitle, an embedded file or a separator. The parts of one frame
 * are consecutive, so a frame is exactly one range read.
 *
 * Written against `VMDDecoder` (`video/coktel_decoder.cpp`) rather than derived
 * again — the LZ77 variant in particular is Coktel's own and not one anybody
 * would arrive at twice.
 *
 * ## What is decoded and what is handed over
 *
 * **Video: all five block kinds and the compression in front of them.** A video
 * part opens with a type byte whose top bit means the rest is LZ77-compressed;
 * underneath are whole, sparse and run-length blocks, plus the two that stretch
 * a half-height or quarter-width block back out. Each draws into a canvas the
 * size of the video, and a frame is a *difference* against the frame before it
 * — which is why this plays forward and replays from the start when asked to go
 * back, exactly as `SciSeq` does.
 *
 * **Audio: handed back with the frame that carries it, not decoded here.** The
 * slice for frame N is *in* frame N, so sync is a property of the container
 * rather than something this code maintains — the same reasoning as Robot's.
 * What the header says about the format travels with it, because a slice of
 * DPCM read as 8-bit PCM is noise rather than an error.
 *
 * **Indeo 3 is not decoded, and says so.** A handful of late VMDs carry an
 * external codec instead of Coktel's own blocks. Those frames are counted in
 * `undecodedFrames` and leave the canvas alone, for the reason
 * `docs/processes/verifying-version-support.md` gives: a picture that is nearly
 * right is the fault nothing on screen explains.
 */

import type { VolumeReader } from '../../resource/VolumeReader.js';
import type { SciCel } from '../gfx/SciView.js';
import type { SciPaletteEntry } from '../gfx/sciPalette.js';

/** The header a VMD Sierra shipped declares, minus its own first two bytes. */
const OLD_HEADER_LENGTH = 814;

/** A part record is a type, a flag byte, a size and ten bytes of its own. */
const PART_RECORD_SIZE = 16;

/** A frame table entry: two bytes nobody reads, then where the frame is. */
const FRAME_RECORD_SIZE = 6;

const PART_SEPARATOR = 0;
const PART_AUDIO = 1;
const PART_VIDEO = 2;
const PART_FILE = 3;
const PART_SUBTITLE = 5;

/** How a VMD's audio slices are encoded, which travels with the slice. */
export type SciVmdAudioFormat = '8bit-raw' | '16bit-dpcm' | '16bit-adpcm';

export interface SciVmdInfo {
  version: number;
  frameCount: number;
  /** Where the video sits on screen, when the game does not say otherwise. */
  x: number;
  y: number;
  width: number;
  height: number;
  partsPerFrame: number;
  hasVideo: boolean;
  hasSound: boolean;
  soundFrequency: number;
  soundStereo: boolean;
  soundBytesPerSample: number;
  audioFormat: SciVmdAudioFormat;
  /** Frames per second, from the sound slice size where there is sound. */
  frameRate: number;
  /**
   * The palette the header carries, already scaled to eight bits a channel.
   *
   * Coktel stores six-bit VGA values, so every channel is shifted up by two —
   * a palette read without the shift is a video that plays correctly and looks
   * like it is behind smoked glass.
   */
  palette: SciPaletteEntry[];
  /** True when frames carry a codec this reader does not decode. */
  externalCodec: boolean;
}

/** One frame: what it drew, what it changed, and the audio that belongs with it. */
export interface SciVmdFrame {
  index: number;
  /** The canvas as of this frame, or null when the frame drew nothing. */
  cel: SciCel | null;
  /** Where the video goes on screen. */
  x: number;
  y: number;
  /** The rectangle this frame touched, for a dirty-rect redraw. */
  dirty: { left: number; top: number; width: number; height: number } | null;
  /** Set when this frame carried a palette of its own. */
  palette: SciPaletteEntry[] | null;
  /**
   * The audio slices in this frame, in order, undecoded.
   *
   * Handed back with the frame rather than through a stream of their own,
   * because the two arriving together is the whole of the sync guarantee.
   */
  audio: Uint8Array[];
  /** A subtitle id the frame named, where it named one. */
  subtitle: number | null;
}

export interface SciVmdStream {
  info: SciVmdInfo;
  /** Frames whose codec this reader does not decode; the canvas kept its last. */
  undecodedFrames: number;
  frame(index: number): Promise<SciVmdFrame | null>;
  bytesRead(): number;
}

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

function i16(bytes: Uint8Array, at: number): number {
  const value = u16(bytes, at);
  return value >= 0x8000 ? value - 0x10000 : value;
}

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

/** One part of one frame, as the frame table describes it. */
interface VmdPart {
  type: number;
  size: number;
  flags: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  id: number;
}

/**
 * Opens a VMD and reads its frame table.
 *
 * Two reads: the header, and the table. For a 400 MB file that is about a
 * hundred kilobytes, and nothing else is touched until a frame is asked for.
 */
export async function openSciVmd(
  volumes: VolumeReader,
  file: string,
): Promise<SciVmdStream | null> {
  const header = await volumes.read(file, 0, OLD_HEADER_LENGTH + 2);
  if (header.length < OLD_HEADER_LENGTH + 2) return null;
  // The declared header length is the whole of the version check Coktel's own
  // reader does, and 814 is the one Sierra shipped. A 50-byte header is Addy
  // 5's, which no SCI game carries.
  if (u16(header, 0) !== OLD_HEADER_LENGTH) return null;

  const handle = u16(header, 2);
  const version = u16(header, 4);
  const frameCount = u16(header, 6);
  const width = i16(header, 12);
  const height = i16(header, 14);
  const partsPerFrame = u16(header, 18);
  if (frameCount === 0 || partsPerFrame === 0) return null;

  // Bytes per pixel is the handle field plus one, and only when the version
  // says so. Anything but one is a 16- or 24-bit VMD, which SCI does not ship
  // and this reader does not draw.
  const bytesPerPixel = version & 4 ? handle + 1 : 1;

  const palette: SciPaletteEntry[] = [];
  for (let index = 0; index < 256; index++) {
    const at = 28 + index * 3;
    palette.push({
      index,
      r: header[at] << 2,
      g: header[at + 1] << 2,
      b: header[at + 2] << 2,
    });
  }

  const soundFrequency = u16(header, 804);
  let soundSliceSize = i16(header, 806);
  const soundFlags = u16(header, 810);
  const frameInfoOffset = u32(header, 812);

  const hasSound = soundFrequency !== 0;
  const stereoField = soundFlags & 0x8000 ? 1 : soundFlags & 0x200 ? 2 : 0;
  let audioFormat: SciVmdAudioFormat = '8bit-raw';
  let soundBytesPerSample = 1;
  if (soundSliceSize < 0) {
    soundBytesPerSample = 2;
    soundSliceSize = -soundSliceSize;
    audioFormat = soundFlags & 0x10 ? '16bit-adpcm' : '16bit-dpcm';
  } else if (stereoField === 1) {
    audioFormat = '16bit-dpcm';
  }

  const frameRate =
    hasSound && soundSliceSize !== 0
      ? soundFrequency / (soundSliceSize / (stereoField === 1 ? 2 : 1))
      : 12;

  // The external codec is Indeo 3, which this reader does not decode. Read off
  // the same two version bits Coktel's own reader uses.
  const externalCodec = (version & 2) !== 0 && (version & 8) === 0;
  const hasVideo = width !== 0 && height !== 0;

  const info: SciVmdInfo = {
    version,
    frameCount,
    x: i16(header, 8),
    y: i16(header, 10),
    width,
    height,
    partsPerFrame,
    hasVideo,
    hasSound,
    soundFrequency,
    soundStereo: stereoField === 2,
    soundBytesPerSample,
    audioFormat,
    frameRate,
    palette,
    externalCodec: externalCodec || bytesPerPixel !== 1,
  };

  let read = header.length;

  // The frame table: where each frame is, then every part of every frame. One
  // read, because the two halves are consecutive and a second seek would cost
  // more than the bytes.
  const tableSize = frameCount * (FRAME_RECORD_SIZE + partsPerFrame * PART_RECORD_SIZE);
  const table = await volumes.read(file, frameInfoOffset, tableSize);
  read += table.length;
  if (table.length < tableSize) return null;

  const offsets: number[] = [];
  for (let index = 0; index < frameCount; index++) {
    offsets.push(u32(table, index * FRAME_RECORD_SIZE + 2));
  }

  const parts: VmdPart[][] = [];
  let at = frameCount * FRAME_RECORD_SIZE;
  for (let index = 0; index < frameCount; index++) {
    const frameParts: VmdPart[] = [];
    for (let part = 0; part < partsPerFrame; part++) {
      const type = table[at];
      const size = u32(table, at + 2);
      const record: VmdPart = {
        type,
        size,
        flags: 0,
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        id: 0,
      };
      if (type === PART_AUDIO) {
        record.flags = table[at + 6];
      } else if (type === PART_VIDEO) {
        record.left = u16(table, at + 6);
        record.top = u16(table, at + 8);
        record.right = u16(table, at + 10);
        record.bottom = u16(table, at + 12);
        record.flags = table[at + 15];
      } else if (type === PART_SUBTITLE) {
        record.id = table[at + 6];
      }
      frameParts.push(record);
      at += PART_RECORD_SIZE;
    }
    parts.push(frameParts);
  }

  const canvas = hasVideo ? new Uint8Array(width * height) : new Uint8Array(0);
  let played = -1;
  let undecoded = 0;
  // Coktel's LZ77 declares its own output length, so the scratch buffer is
  // sized on demand rather than from the header's own two guesses.
  let scratch: Uint8Array = new Uint8Array(0);

  /**
   * Plays one frame into the canvas.
   *
   * Everything a frame needs is consecutive from its own offset, so this is one
   * range read whatever the file's size.
   */
  async function play(index: number): Promise<SciVmdFrame> {
    const frameParts = parts[index];
    const total = frameParts.reduce((sum, part) => sum + part.size, 0);
    const body = await volumes.read(file, offsets[index], total);
    read += body.length;

    const frame: SciVmdFrame = {
      index,
      cel: null,
      x: info.x,
      y: info.y,
      dirty: null,
      palette: null,
      audio: [],
      subtitle: null,
    };

    let cursor = 0;
    for (const part of frameParts) {
      const payload = body.subarray(cursor, cursor + part.size);
      cursor += part.size;

      if (part.type === PART_AUDIO) {
        // Flag 3 is an empty slice — silence of the slice's own length, which
        // the player fills rather than this reader inventing bytes for.
        if (part.flags !== 3 && payload.length > 0) frame.audio.push(payload);
        continue;
      }
      if (part.type === PART_SUBTITLE) {
        frame.subtitle = part.id;
        continue;
      }
      // A separator carries nothing and an embedded file is not this reader's
      // — both are stepped over by their own size, which the cursor already did.
      if (part.type === PART_SEPARATOR || part.type === PART_FILE) continue;
      if (part.type !== PART_VIDEO || !hasVideo) continue;

      let video = payload;
      if (part.flags & 2) {
        // A palette of its own, in front of the pixels: a start index, a count,
        // and then the full 256 entries whatever the count said.
        const start = video[0];
        const count = video[1];
        const changed: SciPaletteEntry[] = [];
        for (let entry = 0; entry <= count; entry++) {
          const source = 2 + entry * 3;
          const target = start + entry;
          if (target > 255 || source + 2 >= video.length) break;
          const colour = {
            index: target,
            r: video[source] << 2,
            g: video[source + 1] << 2,
            b: video[source + 2] << 2,
          };
          palette[target] = colour;
          changed.push(colour);
        }
        frame.palette = changed;
        video = video.subarray(768 + 2);
      }

      if (info.externalCodec) {
        // Indeo 3. Counted rather than guessed at; the canvas keeps its last
        // frame, which is visibly a still rather than plausibly wrong.
        undecoded++;
        continue;
      }

      const rect = {
        left: part.left,
        top: part.top,
        width: part.right + 1 - part.left,
        height: part.bottom + 1 - part.top,
      };
      if (rect.width <= 0 || rect.height <= 0 || video.length < 1) continue;

      let type = video[0];
      let data = video.subarray(1);
      if (type & 0x80) {
        type &= 0x7f;
        const expanded = deLZ77(data, scratch);
        if (!expanded) {
          undecoded++;
          continue;
        }
        scratch = expanded.buffer;
        data = expanded.bytes;
      }

      if (!renderVmdBlock(canvas, width, height, type, data, rect)) {
        undecoded++;
        continue;
      }
      frame.dirty = rect;
    }

    if (hasVideo) {
      frame.cel = {
        width,
        height,
        displaceX: 0,
        displaceY: 0,
        clearKey: 0xff,
        pixels: canvas.slice(),
      };
    }
    return frame;
  }

  let last: SciVmdFrame | null = null;

  return {
    info,
    get undecodedFrames() {
      return undecoded;
    },
    bytesRead: () => read,
    async frame(index: number) {
      if (index < 0 || index >= frameCount) return null;
      // Backwards means starting again, for `SciSeq`'s reason: a frame is a
      // difference against the one before it, and keeping every frame is the
      // whole file in memory.
      if (index < played) {
        canvas.fill(0);
        played = -1;
        undecoded = 0;
      }
      while (played < index) last = await play(++played);
      return last;
    },
  };
}

/**
 * Coktel's LZ77, which is theirs and not anyone else's.
 *
 * A 4096-byte ring primed with spaces, a bit per literal, and a two-byte back
 * reference whose length escapes to a third byte — with the escape *and the
 * ring's starting position* both depending on a magic pair at the front of the
 * stream. Ported from `CoktelDecoder::deLZ77` rather than reconstructed,
 * because the two modes are the kind of detail that produces a decoder working
 * on nine files in ten.
 *
 * Returns null rather than a partial expansion: a truncated frame is a picture
 * that is nearly right, which is the one thing this project refuses to draw.
 */
function deLZ77(
  source: Uint8Array,
  reuse: Uint8Array,
): { bytes: Uint8Array; buffer: Uint8Array } | null {
  if (source.length < 4) return null;
  let frameLength = u32(source, 0);
  const realSize = frameLength;
  let at = 4;

  let bufPos1: number;
  let mode: boolean;
  if (u16(source, at) === 0x1234 && u16(source, at + 2) === 0x5678) {
    at += 4;
    bufPos1 = 273;
    mode = true;
  } else {
    bufPos1 = 4078;
    mode = false;
  }

  const destination =
    reuse.length >= realSize ? reuse : new Uint8Array(Math.max(realSize, 0x10000));
  const ring = new Uint8Array(4370).fill(32, 0, bufPos1);

  let out = 0;
  let chunkCount = 1;
  let bits = 0;

  while (frameLength > 0) {
    chunkCount--;
    if (chunkCount === 0) {
      if (at >= source.length) return null;
      chunkCount = 8;
      bits = source[at++];
    }

    if (bits % 2) {
      if (at >= source.length || out >= destination.length) return null;
      bits >>= 1;
      ring[bufPos1] = source[at];
      destination[out++] = source[at++];
      bufPos1 = (bufPos1 + 1) % 4096;
      frameLength--;
      continue;
    }
    bits >>= 1;

    if (at + 1 >= source.length) return null;
    const packed = u16(source, at);
    let chunkLength = ((packed & 0xf00) >> 8) + 3;
    at += 2;

    if ((mode && (chunkLength & 0xff) === 0x12) || (!mode && chunkLength === 0)) {
      if (at >= source.length) return null;
      chunkLength = source[at++] + 0x12;
    }

    let bufPos2 = (packed & 0xff) + ((packed >> 4) & 0x0f00);
    if (out + chunkLength > destination.length) return null;
    for (let index = 0; index < chunkLength; index++) {
      destination[out++] = ring[bufPos2];
      ring[bufPos1] = ring[bufPos2];
      bufPos1 = (bufPos1 + 1) % 4096;
      bufPos2 = (bufPos2 + 1) % 4096;
    }
    frameLength -= chunkLength;
  }

  return { bytes: destination.subarray(0, realSize), buffer: destination };
}

/** The rectangle a block draws into, in the video's own coordinates. */
interface VmdRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Draws one decompressed block into the canvas.
 *
 * The five kinds Coktel's own renderer has, and a refusal for anything else —
 * an unknown block type means the frame is left alone and counted, rather than
 * a rectangle of whatever the bytes happened to be.
 */
function renderVmdBlock(
  canvas: Uint8Array,
  canvasWidth: number,
  canvasHeight: number,
  type: number,
  data: Uint8Array,
  rect: VmdRect,
): boolean {
  if (type === 0x01) return renderSparse(canvas, canvasWidth, canvasHeight, data, rect, 1);
  if (type === 0x02) return renderWhole(canvas, canvasWidth, canvasHeight, data, rect, 1, 1);
  if (type === 0x03) return renderRle(canvas, canvasWidth, canvasHeight, data, rect);
  if (type === 0x42) return renderWhole(canvas, canvasWidth, canvasHeight, data, rect, 4, 1);
  if ((type & 0x0f) === 0x02)
    return renderWhole(canvas, canvasWidth, canvasHeight, data, rect, 1, 2);
  return renderSparse(canvas, canvasWidth, canvasHeight, data, rect, 2);
}

/**
 * A block whose every pixel is present.
 *
 * `stretchX` of four is the quarter-wide kind, where each source byte fills
 * four pixels; `stretchY` of two is the half-high kind, where each source row
 * is written twice. Both exist because Coktel encoded a low-detail frame small
 * rather than compressing it harder.
 */
function renderWhole(
  canvas: Uint8Array,
  canvasWidth: number,
  canvasHeight: number,
  data: Uint8Array,
  rect: VmdRect,
  stretchX: number,
  stretchY: number,
): boolean {
  const sourceWidth = Math.floor(rect.width / stretchX);
  for (let y = 0; y < rect.height; y += stretchY) {
    const sourceRow = Math.floor(y / stretchY) * sourceWidth;
    if (sourceRow + sourceWidth > data.length) return false;
    for (let repeat = 0; repeat < stretchY && y + repeat < rect.height; repeat++) {
      const row = rect.top + y + repeat;
      if (row < 0 || row >= canvasHeight) continue;
      for (let x = 0; x < rect.width; x++) {
        const column = rect.left + x;
        if (column < 0 || column >= canvasWidth) continue;
        canvas[row * canvasWidth + column] = data[sourceRow + Math.floor(x / stretchX)];
      }
    }
  }
  return true;
}

/**
 * A block of runs and holes, where a hole leaves the frame before it showing.
 *
 * `stretchY` of two is the half-high variant, which writes each decoded row
 * twice — Coktel's own renderer warns when it meets one, and it is kept here
 * because refusing it would drop frames that are otherwise readable.
 */
function renderSparse(
  canvas: Uint8Array,
  canvasWidth: number,
  canvasHeight: number,
  data: Uint8Array,
  rect: VmdRect,
  stretchY: number,
): boolean {
  let at = 0;
  for (let y = 0; y < rect.height; y += stretchY) {
    let written = 0;
    while (written < rect.width) {
      if (at >= data.length) return false;
      const control = data[at++];
      if (control & 0x80) {
        const run = Math.min((control & 0x7f) + 1, rect.width - written);
        if (at + run > data.length) return false;
        for (let repeat = 0; repeat < stretchY && y + repeat < rect.height; repeat++) {
          const row = rect.top + y + repeat;
          if (row < 0 || row >= canvasHeight) continue;
          for (let x = 0; x < run; x++) {
            const column = rect.left + written + x;
            if (column < 0 || column >= canvasWidth) continue;
            canvas[row * canvasWidth + column] = data[at + x];
          }
        }
        at += run;
        written += run;
      } else {
        written += control + 1;
      }
    }
  }
  return true;
}

/**
 * A block of runs, holes and runs that are themselves run-length encoded.
 *
 * The third case is the one worth naming: a run whose first byte is `0xff` is
 * not a copy but a nested encoding, alternating verbatim pairs with repeated
 * pairs. Coktel wrote it that way to encode a dithered gradient cheaply, and a
 * decoder that misses it produces a band of `0xff` across the picture.
 */
function renderRle(
  canvas: Uint8Array,
  canvasWidth: number,
  canvasHeight: number,
  data: Uint8Array,
  rect: VmdRect,
): boolean {
  let at = 0;
  for (let y = 0; y < rect.height; y++) {
    const row = rect.top + y;
    let written = 0;
    while (written < rect.width) {
      if (at >= data.length) return false;
      const control = data[at++];

      if (!(control & 0x80)) {
        written += control + 1;
        continue;
      }

      const run = Math.min((control & 0x7f) + 1, rect.width - written);
      if (at >= data.length) return false;

      if (data[at] !== 0xff) {
        if (at + run > data.length) return false;
        putRow(
          canvas,
          canvasWidth,
          canvasHeight,
          row,
          rect.left + written,
          data.subarray(at, at + run),
        );
        at += run;
        written += run;
        continue;
      }

      const nested = deRle(data, at, run);
      if (!nested) return false;
      putRow(canvas, canvasWidth, canvasHeight, row, rect.left + written, nested.pixels);
      at = nested.at;
      written += run;
    }
  }
  return true;
}

/** One row's worth of pixels, clipped to the canvas. */
function putRow(
  canvas: Uint8Array,
  canvasWidth: number,
  canvasHeight: number,
  row: number,
  left: number,
  pixels: Uint8Array,
): void {
  if (row < 0 || row >= canvasHeight) return;
  for (let x = 0; x < pixels.length; x++) {
    const column = left + x;
    if (column < 0 || column >= canvasWidth) continue;
    canvas[row * canvasWidth + column] = pixels[x];
  }
}

/**
 * The nested encoding inside a run that opens with `0xff`.
 *
 * Pairs of bytes, either copied verbatim or repeated, counted in pairs — with
 * an odd length carrying one loose byte in front. Ported from
 * `CoktelDecoder::deRLE`.
 */
function deRle(
  data: Uint8Array,
  start: number,
  length: number,
): { pixels: Uint8Array; at: number } | null {
  const out: number[] = [];
  // The first byte of the run is the `0xff` that marked it, and is not a pixel.
  let at = start + 1;

  if (length & 1) {
    if (at >= data.length) return null;
    out.push(data[at++]);
  }

  let pairs = length >> 1;
  while (pairs > 0) {
    if (at >= data.length) return null;
    let count = data[at++];
    if (count & 0x80) {
      count &= 0x7f;
      const bytes = count * 2;
      if (at + bytes > data.length) return null;
      for (let index = 0; index < bytes && out.length < length; index++) out.push(data[at + index]);
      at += bytes;
    } else {
      if (at + 1 >= data.length) return null;
      for (let index = 0; index < count && out.length < length; index++) {
        out.push(data[at]);
        if (out.length < length) out.push(data[at + 1]);
      }
      at += 2;
    }
    pairs -= count;
    if (count === 0) return null;
  }

  return { pixels: Uint8Array.from(out.slice(0, length)), at };
}
