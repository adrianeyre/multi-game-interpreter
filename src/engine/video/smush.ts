import { SCREEN_HEIGHT, SCREEN_WIDTH } from '../gfx/Screen.js';
import { Codec37Decoder } from './codec37.js';
import { Codec47Decoder } from './codec47.js';

/**
 * SMUSH: the full-motion video format v7 introduced.
 *
 * A subsystem rather than a leaf under `gfx` or `sound`, because SMUSH is not
 * on the version axis at all — nothing before v7 uses it and it is not a
 * variation on anything that exists (ADR 0007).
 *
 * A `.SAN` file is an `ANIM` container holding an `AHDR` header and then one
 * `FRME` chunk per frame. Chunk sizes are **big-endian**, as in the SCUMM
 * container, but everything inside a chunk is little-endian.
 *
 * Frames are not independent. A frame carries only what changed, and several
 * chunk kinds exist to say "reuse what is already on screen" — so decoding
 * frame *n* requires having decoded every frame before it. That is why this
 * reader is a cursor over the file rather than a function from frame number to
 * pixels: the second shape would invite a seek that silently produces a frame
 * built on the wrong history.
 *
 * (`SmushPlayer::parseNextFrame` and `handleAnimHeader` in ScummVM.)
 */

/** Codec numbers, from ScummVM's `smush_player.h`. */
export const SmushCodec = {
  /** Run-length encoded lines, in the same encoding as a BOMP costume cel. */
  Rle: 1,
  /** The same encoding under a second number; ScummVM dispatches both alike. */
  RleAlt: 3,
  /** Raw bytes, one per pixel. */
  Uncompressed: 20,
  /** Motion-compensated blocks, over two frame buffers. */
  DeltaBlocks: 37,
  /** Motion-compensated blocks with a generated glyph table. */
  DeltaGlyphs: 47,
} as const;

/** The palette an `AHDR` carries: 256 colours of three bytes. */
const PALETTE_BYTES = 0x300;

/** `AHDR` is two version bytes, a frame count, two spare, then the palette. */
const AHDR_PALETTE_OFFSET = 6;

export interface SmushHeader {
  majorVersion: number;
  minorVersion: number;
  frameCount: number;
  /** 256 RGB triples, as the file carries them. */
  palette: Uint8Array;
  /**
   * Frames per second, when the file overrides the default.
   *
   * Only written by header version 2 and later, and only meaningful when
   * non-zero. A video played at the wrong rate is the failure a fixture cannot
   * see and a person cannot miss, so this is read rather than assumed.
   */
  speed: number | null;
}

export interface SmushFrame {
  /** Chunks in this frame, in file order, as tag and payload. */
  chunks: Array<{ tag: string; data: Uint8Array }>;
}

/** A tag and a big-endian size, as the SMUSH container frames every chunk. */
interface SmushChunk {
  tag: string;
  dataOffset: number;
  dataSize: number;
  /** Offset of the next chunk, with the odd-size padding applied. */
  next: number;
}

function readChunk(bytes: Uint8Array, at: number): SmushChunk | null {
  if (at + 8 > bytes.length) return null;
  let tag = '';
  for (let i = 0; i < 4; i++) tag += String.fromCharCode(bytes[at + i]);
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const dataSize = view.getUint32(at + 4, false);
  const dataOffset = at + 8;
  if (dataOffset + dataSize > bytes.length) return null;
  // Chunks are padded to an even boundary. Without this every chunk after the
  // first odd-sized one is read from one byte early, which decodes as a
  // plausible tag often enough to be confusing.
  return { tag, dataOffset, dataSize, next: dataOffset + dataSize + (dataSize & 1) };
}

/**
 * Reads a `.SAN` file's header and frame table.
 *
 * Returns null when the file is not a SMUSH animation, rather than throwing: a
 * `.SAN` that will not open is a missing cutscene, and naming it is more use
 * than an exception from inside a frame loop.
 */
export function readSmushFile(
  bytes: Uint8Array,
): { header: SmushHeader; frames: SmushFrame[] } | null {
  const anim = readChunk(bytes, 0);
  if (!anim || anim.tag !== 'ANIM') return null;

  const end = anim.dataOffset + anim.dataSize;
  const ahdr = readChunk(bytes, anim.dataOffset);
  if (!ahdr || ahdr.tag !== 'AHDR') return null;
  if (ahdr.dataSize < AHDR_PALETTE_OFFSET + PALETTE_BYTES) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const majorVersion = bytes[ahdr.dataOffset];
  const minorVersion = bytes[ahdr.dataOffset + 1];
  const frameCount = view.getUint16(ahdr.dataOffset + 2, true);
  const palette = bytes.slice(
    ahdr.dataOffset + AHDR_PALETTE_OFFSET,
    ahdr.dataOffset + AHDR_PALETTE_OFFSET + PALETTE_BYTES,
  );

  let speed: number | null = null;
  const speedAt = ahdr.dataOffset + AHDR_PALETTE_OFFSET + PALETTE_BYTES;
  if (majorVersion > 1 && speedAt + 2 <= ahdr.dataOffset + ahdr.dataSize) {
    const declared = view.getUint16(speedAt, true);
    if (declared !== 0) speed = declared;
  }

  const frames: SmushFrame[] = [];
  let cursor = ahdr.next;
  while (cursor < end) {
    const frame = readChunk(bytes, cursor);
    if (!frame) break;
    if (frame.tag === 'FRME') {
      const chunks: Array<{ tag: string; data: Uint8Array }> = [];
      let inner = frame.dataOffset;
      const frameEnd = frame.dataOffset + frame.dataSize;
      while (inner < frameEnd) {
        const child = readChunk(bytes, inner);
        if (!child) break;
        chunks.push({
          tag: child.tag,
          data: bytes.subarray(child.dataOffset, child.dataOffset + child.dataSize),
        });
        inner = child.next;
      }
      frames.push({ chunks });
    }
    cursor = frame.next;
  }

  return {
    header: { majorVersion, minorVersion, frameCount, palette, speed },
    frames,
  };
}

/** A frame object's header: a codec and the rectangle it covers. */
export interface FrameObject {
  codec: number;
  left: number;
  top: number;
  width: number;
  height: number;
  data: Uint8Array;
}

/** `FOBJ`: a 14-byte header, then the codec's own data. */
export function readFrameObject(chunk: Uint8Array): FrameObject | null {
  if (chunk.length < 14) return null;
  const view = new DataView(chunk.buffer, chunk.byteOffset);
  return {
    codec: view.getUint16(0, true),
    left: view.getInt16(2, true),
    top: view.getInt16(4, true),
    width: view.getUint16(6, true),
    height: view.getUint16(8, true),
    data: chunk.subarray(14),
  };
}

/**
 * One run-length encoded line, written opaquely.
 *
 * Deliberately not `decodeBompLine` from `gfx/costume`, which is the same
 * encoding read with a different rule: there colour 0 is transparent, because a
 * costume is drawn over a room. A video frame *is* the picture, so a zero is a
 * black pixel and skipping it would leave the previous frame showing through
 * every shadow.
 */
function decodeRleLineOpaque(source: Uint8Array, at: number, out: Uint8Array, width: number): void {
  let remaining = width;
  let read = at;
  let write = 0;

  while (remaining > 0 && read < source.length) {
    const code = source[read++];
    const count = Math.min((code >> 1) + 1, remaining);
    remaining -= count;

    if (code & 1) {
      out.fill(source[read++], write, write + count);
    } else {
      for (let i = 0; i < count; i++) out[write + i] = source[read + i];
      read += count;
    }
    write += count;
  }
}

/**
 * Draws a frame object into a full-screen 8-bit buffer.
 *
 * Returns false when the codec is not implemented, so the caller can name it
 * by number once rather than drawing garbage — an unhandled codec that silently
 * leaves the previous frame up looks like a stalled video, which is far harder
 * to diagnose than a log line.
 */
/**
 * Codec 37's decoder, which has to persist between frames.
 *
 * Held per sequence rather than per frame: the codec's whole economy is that
 * most blocks are references into the previous two frames, so a decoder created
 * fresh each frame would have nothing to reference and would draw a still of
 * whatever the first frame happened to be.
 */
export function createCodec37Decoder(width: number, height: number): Codec37Decoder {
  return new Codec37Decoder(width, height);
}

/** Codec 47's decoder, which persists between frames for the same reason. */
export function createCodec47Decoder(width: number, height: number): Codec47Decoder {
  return new Codec47Decoder(width, height);
}

export function drawFrameObject(
  object: FrameObject,
  target: Uint8Array,
  codec37?: Codec37Decoder,
  codec47?: Codec47Decoder,
): boolean {
  switch (object.codec) {
    case SmushCodec.DeltaGlyphs: {
      if (!codec47) return false;
      const frame = new Uint8Array(object.width * object.height);
      if (!codec47.decode(object.data, frame)) return false;
      for (let y = 0; y < object.height; y++) {
        blit(frame.subarray(y * object.width, (y + 1) * object.width), object, target, y);
      }
      return true;
    }

    case SmushCodec.DeltaBlocks: {
      // Needs the decoder that has been following this sequence. Without one,
      // reported rather than drawn — a frame decoded against empty buffers is
      // a plausible-looking wrong picture.
      if (!codec37) return false;
      const frame = new Uint8Array(object.width * object.height);
      if (!codec37.decode(object.data, frame)) return false;
      for (let y = 0; y < object.height; y++) {
        blit(frame.subarray(y * object.width, (y + 1) * object.width), object, target, y);
      }
      return true;
    }

    case SmushCodec.Rle:
    case SmushCodec.RleAlt: {
      // Each line is a 16-bit byte count and then that many bytes of control
      // stream. The count is what lets the next line be found without decoding
      // this one, and it is counted from after itself.
      const line = new Uint8Array(object.width);
      let read = 0;
      for (let y = 0; y < object.height; y++) {
        if (read + 2 > object.data.length) break;
        const size = object.data[read] | (object.data[read + 1] << 8);
        line.fill(0);
        decodeRleLineOpaque(object.data, read + 2, line, object.width);
        blit(line, object, target, y);
        read += size + 2;
      }
      return true;
    }

    case SmushCodec.Uncompressed: {
      for (let y = 0; y < object.height; y++) {
        const from = y * object.width;
        if (from + object.width > object.data.length) break;
        blit(object.data.subarray(from, from + object.width), object, target, y);
      }
      return true;
    }

    default:
      return false;
  }
}

/** Copies one decoded line into the framebuffer, clipped to the screen. */
function blit(line: Uint8Array, object: FrameObject, target: Uint8Array, y: number): void {
  const destY = object.top + y;
  if (destY < 0 || destY >= SCREEN_HEIGHT) return;

  const from = Math.max(0, -object.left);
  const to = Math.min(object.width, SCREEN_WIDTH - object.left);
  if (to <= from) return;

  target.set(line.subarray(from, to), destY * SCREEN_WIDTH + object.left + from);
}

/** The palette a `NPAL` chunk carries: 256 RGB triples. */
export function readPaletteChunk(chunk: Uint8Array): Uint8Array | null {
  if (chunk.length < PALETTE_BYTES) return null;
  return chunk.subarray(0, PALETTE_BYTES);
}

/**
 * `XPAL`: a palette that moves while the frames hold still.
 *
 * Both v7 games fade with this rather than by re-sending a palette per frame,
 * and it is the reason a video decoded without it looks *almost* right: the
 * pictures are correct and every fade is a hard cut.
 *
 * The encoding is a set-then-step pair. One chunk carries 768 signed deltas —
 * one per palette component — and later chunks say only "take another step".
 * Each component is accumulated at seven extra bits of precision and shifted
 * back down on read, so a fade over forty frames does not quantise to a dozen
 * visible bands.
 *
 * The form is chosen by a command word rather than by the chunk's length, which
 * matters because the step form is six bytes and a truncated set form could be
 * anything. (`SmushPlayer::handleDeltaPalette`.)
 */
export const XPAL_COMMAND = {
  /** Advance every component by its delta, and nothing else. */
  Step: 256,
  /** Set the deltas, and read a new base palette behind them. */
  SetWithPalette: 512,
} as const;

/** Where the deltas start: an unused word, then the command word. */
const XPAL_HEADER_BYTES = 4;

/** The step form carries the command and one word nobody reads. */
const XPAL_STEP_BYTES = 6;

export class DeltaPalette {
  /** The palette as it currently stands: 256 RGB triples. */
  readonly colours = new Uint8Array(PALETTE_BYTES);

  /** One signed delta per component, from the last set form. */
  private readonly deltas = new Int16Array(PALETTE_BYTES);

  /**
   * Each component held at seven extra bits.
   *
   * Not derivable from `colours`: it is seeded when the deltas arrive and then
   * accumulates independently, so an `NPAL` between two steps changes what is
   * displayed without changing where the fade is up to — which is what the
   * original does.
   */
  private readonly shifted = new Int32Array(PALETTE_BYTES);

  /**
   * `NPAL`: a new palette, mid-sequence.
   *
   * Deliberately does not touch the accumulator. A palette arriving between two
   * steps changes what is on screen without changing where the fade is up to,
   * which is what the original does — and what lets a sequence swap a palette
   * under a fade that is still running.
   */
  setFull(palette: Uint8Array): void {
    this.colours.set(palette.subarray(0, PALETTE_BYTES));
  }

  /**
   * The palette a sequence opens with, and no fade in progress.
   *
   * Distinct from `setFull` because the accumulator has to start somewhere. A
   * step chunk before any set chunk is a malformed sequence, and with a zeroed
   * accumulator it would fade the whole screen to black rather than do nothing
   * — a failure far louder than the file's own fault.
   */
  reset(palette: Uint8Array): void {
    this.setFull(palette);
    this.deltas.fill(0);
    for (let i = 0; i < PALETTE_BYTES; i++) this.shifted[i] = this.colours[i] << 7;
  }

  /**
   * Applies one `XPAL` chunk.
   *
   * Returns false when the chunk is shorter than the form its command word
   * claims, rather than reading past the end and stepping the palette by
   * whatever followed it in the file.
   */
  apply(chunk: Uint8Array): boolean {
    if (chunk.length < XPAL_HEADER_BYTES) return false;
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.length);
    const command = view.getUint16(2, true);

    if (command === XPAL_COMMAND.Step) {
      if (chunk.length < XPAL_STEP_BYTES) return false;
      for (let i = 0; i < PALETTE_BYTES; i++) {
        this.shifted[i] += this.deltas[i];
        this.colours[i] = Math.max(0, Math.min(255, this.shifted[i] >> 7));
      }
      return true;
    }

    const deltasEnd = XPAL_HEADER_BYTES + PALETTE_BYTES * 2;
    if (chunk.length < deltasEnd) return false;
    for (let i = 0; i < PALETTE_BYTES; i++) {
      // Seeded from the palette on screen, not from the accumulator: a new set
      // of deltas starts the fade from what is showing now.
      this.shifted[i] = this.colours[i] << 7;
      this.deltas[i] = view.getInt16(XPAL_HEADER_BYTES + i * 2, true);
    }

    if (command === XPAL_COMMAND.SetWithPalette) {
      if (chunk.length < deltasEnd + PALETTE_BYTES) return false;
      this.setFull(chunk.subarray(deltasEnd));
      for (let i = 0; i < PALETTE_BYTES; i++) this.shifted[i] = this.colours[i] << 7;
    }
    return true;
  }
}

/**
 * `TEXT` and `TRES`: a line of subtitle, and where on the screen it goes.
 *
 * Sixteen bytes of header either way. The difference is only where the words
 * come from: `TEXT` carries them, and `TRES` carries an index into the game's
 * own string table, which is the same indirection `LANGUAGE.BND` is for.
 * (`SmushPlayer::handleTextResource`.)
 */
export interface SmushTextCue {
  x: number;
  y: number;
  flags: number;
  left: number;
  top: number;
  width: number;
  height: number;
  /** The words, when the chunk carried them. */
  text: string | null;
  /** The string table index, when it carried one instead. */
  stringId: number | null;
}

/** Flag bits, of which only these three change what is drawn here. */
export const SMUSH_TEXT_FLAG = {
  Centre: 0x01,
  WordWrap: 0x04,
  /** Colour and font escapes are literal text rather than instructions. */
  SkipEscapes: 0x80,
} as const;

const TEXT_HEADER_BYTES = 16;

export function readTextCue(chunk: Uint8Array, tag: string): SmushTextCue | null {
  if (chunk.length < TEXT_HEADER_BYTES) return null;
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.length);
  const at = (index: number) => view.getInt16(index * 2, true);

  const cue: SmushTextCue = {
    x: at(0),
    y: at(1),
    flags: at(2),
    left: at(3),
    top: at(4),
    width: at(5),
    height: at(6),
    text: null,
    stringId: null,
  };

  if (tag === 'TRES') {
    if (chunk.length < TEXT_HEADER_BYTES + 2) return null;
    cue.stringId = view.getUint16(TEXT_HEADER_BYTES, true);
    return cue;
  }

  let text = '';
  for (let i = TEXT_HEADER_BYTES; i < chunk.length; i++) {
    const byte = chunk[i];
    if (byte === 0) break;
    text += String.fromCharCode(byte);
  }
  cue.text = text;
  return cue;
}
