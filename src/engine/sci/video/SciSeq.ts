/**
 * SEQ: SCI1.1's full-screen animation, played rather than held.
 *
 * `CONTEXT.md` draws the line for SCUMM and #226 draws it again here: SMUSH is
 * "played by the Engine rather than decoded to a resource", and SEQ, VMD and
 * DUK are that situation exactly — full-screen, played to the end or skipped,
 * nothing a Project reconstructs. A Robot is the one that is not, and it lives
 * in `SciRobot.ts` for that reason.
 *
 * ## The container is self-checking, and it checked out
 *
 * A frame count, a palette, then a frame each. A frame's record says where its
 * data begins and how long it is, so walking the frames should land exactly on
 * the end of the file — and for all twenty-two SEQ files in Sierra's King's
 * Quest VI and Gabriel Knight demos it does, to the byte. That is a stronger
 * check than a fixture can give, and it is why this reader trusts its own
 * arithmetic enough to seek rather than scan.
 *
 * ## The screen is 320x200 and not the first frame's size
 *
 * A frame carries a width, a height and a corner, and it is tempting to size
 * the canvas from the first of them. That is wrong, and wrong in the expensive
 * direction: a difference frame's runs are counted in *screen* rows, so a
 * canvas one pixel narrower than 320 shears every frame after the first by a
 * pixel per row. SEQ is a SCI1.1 format and SCI1.1 displays 320x200, which is
 * why `SEQDecoder` hardcodes the same two numbers.
 *
 * ## A SEQ frame is *nearly* the record everything else uses
 *
 * Width, height, a transparent index and a two-stream run-length body, in that
 * order, at those offsets — the V56 View's record and the cel Picture's. The
 * one field that differs in meaning is the byte at offset 9: for a View and a
 * Picture it is a compression method, and here it is a **frame type**, where
 * zero means the pixels are simply there and anything else means the two
 * streams. So `readSci11Cel` is not reused; the two-stream idea is.
 *
 * ## The sizes are words, and reading them as longs is what hid the codec
 *
 * This file spent a previous round reporting that it could not establish the
 * difference frames' codec: two families of candidate scheme, 260 assignments
 * in all, none of which consumed its control stream, its literal stream and the
 * frame's pixels exactly. **The schemes were not the fault.** A frame record's
 * body size sits at offset 12 and its control-stream size at offset 16, and
 * both are 16-bit — offsets 14 and 18 hold other fields. Reading either as a
 * 32-bit word folds the neighbouring field into the top half, so every decode
 * began by splitting the body in the wrong place. A control stream cut short by
 * a few hundred bytes fails every check a correct decoder would pass, which is
 * exactly what was measured and exactly what it was blamed on.
 *
 * Worth the paragraph, because the shape recurs: the search was over the part
 * that was right.
 *
 * ## The codec, which is four operations and two escapes
 *
 * Written against `SEQDecoder::SEQVideoTrack::decodeFrame`
 * (`engines/sci/video/seq_decoder.cpp`) rather than derived again. A control
 * byte is read, and its top bits say which of three shapes it is:
 *
 * - `0xc0`-`0xff`: the low six bits are a column skip, or a new row when zero.
 * - `0x80`-`0xbf`: the low six bits are a copy from the literal stream, or the
 *   rest of the row when zero.
 * - anything else: the low three bits and the next byte make a 11-bit count,
 *   and bits 3 to 5 choose skip, copy, whole rows copied, or whole rows
 *   skipped — with zero meaning "to the end of the frame" for the last two.
 *
 * Everything is measured in screen rows of 320 from the frame's own top, and
 * columns from the frame's own left, which is why the two are read out of the
 * record rather than assumed.
 *
 * ## What a frame that will not decode does
 *
 * Aborts and leaves the canvas as it was, and is counted in `undecodedFrames`.
 * A control byte in the reserved group, a run that would write past the frame,
 * or a literal stream that runs out are all the same answer, and
 * `docs/processes/verifying-version-support.md` is the reason: a decode that is
 * nearly right produces a picture that is nearly the frame, and every report
 * about engine state looks correct while it is on screen.
 */

import type { VolumeReader } from '../../resource/VolumeReader.js';
import type { SciCel } from '../gfx/SciView.js';
import { readSciPalette, type SciPaletteEntry } from '../gfx/sciPalette.js';

/**
 * The screen a SEQ plays on, which is the Version's and not the file's.
 *
 * SCI1.1 script coordinates. `SEQDecoder` writes the same two numbers into its
 * surface for the same reason, and a difference frame's row arithmetic is
 * against this stride rather than against a frame's own width.
 */
export const SEQ_SCREEN_WIDTH = 320;
export const SEQ_SCREEN_HEIGHT = 200;

/** Where a frame's data is, so it can be fetched without reading what precedes it. */
interface SeqFrameIndex {
  width: number;
  height: number;
  left: number;
  top: number;
  clearKey: number;
  /** Zero means the pixels are stored; anything else means the two streams. */
  frameType: number;
  dataAt: number;
  /** Bytes of body: the two streams together for a difference frame. */
  dataSize: number;
  /** How much of the body is control stream; the rest is literals. */
  rleSize: number;
}

export interface SciSeqStream {
  frameCount: number;
  palette: SciPaletteEntry[];
  /** The screen, which is 320x200 for every SEQ. */
  width: number;
  height: number;
  /**
   * How many frames aborted rather than drawing.
   *
   * Zero for every SEQ whose codec this reads, which is now all of them.
   * Non-zero means a frame's control stream asked for something outside the
   * format as read here, and the honest report is that this animation dropped
   * a frame rather than that it showed something plausible.
   */
  undecodedFrames: number;
  /**
   * The canvas as of frame `index`, playing forward from wherever it is.
   *
   * Sequential is the cheap direction and the only one a player needs — SEQ is
   * "played to the end or skipped". Asking for an earlier frame replays from
   * the first, which is correct and slow, and saying so here is better than a
   * seek that silently returns a frame built on the wrong predecessor.
   */
  frame(index: number): Promise<{ cel: SciCel; left: number; top: number } | null>;
  bytesRead(): number;
}

/**
 * How much of a frame record is read.
 *
 * `SEQDecoder` reads 28 bytes and then seeks to the body's own offset, so the
 * fields past 27 are nobody's. Thirty-six is read here because the last field
 * this wants ends at 28 and a single larger read is the same round trip.
 */
const FRAME_HEADER_SIZE = 36;

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

/**
 * Opens a SEQ and indexes its frames.
 *
 * The index costs one read of the header and palette and then a 36-byte read
 * per frame — a few kilobytes for a one-megabyte file — and a frame's pixels
 * are fetched only when that frame is asked for. A player that skips after two
 * frames has read two frames.
 */
export async function openSciSeq(
  volumes: VolumeReader,
  file: string,
): Promise<SciSeqStream | null> {
  const head = await volumes.read(file, 0, 6);
  if (head.length < 6) return null;

  const frameCount = u16(head, 0);
  const paletteSize = u32(head, 2);
  // A frame count of zero, or a palette larger than any SEQ carries, means this
  // is not a SEQ — the format has no magic number, so the plausibility of its
  // own first two fields is the whole of the test.
  if (frameCount === 0 || frameCount > 10000 || paletteSize < 6 || paletteSize > 0x10000) {
    return null;
  }

  const paletteBytes = await volumes.read(file, 6, paletteSize);
  let read = 6 + paletteBytes.length;
  const palette = readSciPalette(paletteBytes, 0);

  const frames: SeqFrameIndex[] = [];
  let at = 6 + paletteSize;
  for (let index = 0; index < frameCount; index++) {
    const header = await volumes.read(file, at, FRAME_HEADER_SIZE);
    read += header.length;
    if (header.length < 28) break;

    const width = u16(header, 0);
    const height = u16(header, 2);
    const frameType = header[9];
    const dataAt = u32(header, 24);
    if (width === 0 || height === 0 || dataAt === 0) break;

    // Both sizes are 16-bit and both have a different field immediately after
    // them. See the note at the top of this file: reading either as a 32-bit
    // word is what made this format look undecodable.
    const bodySize = u16(header, 12);
    frames.push({
      width,
      height,
      left: u16(header, 4),
      top: u16(header, 6),
      clearKey: header[8],
      frameType,
      dataAt,
      dataSize: frameType === 0 ? width * height : bodySize,
      rleSize: u16(header, 16),
    });
    at = dataAt + frames[frames.length - 1].dataSize;
  }

  if (frames.length === 0) return null;

  const width = SEQ_SCREEN_WIDTH;
  const height = SEQ_SCREEN_HEIGHT;
  // The canvas every frame after the first is a difference against. Cleared to
  // the first frame's transparent index, which is what a SEQ opens against.
  const canvas = new Uint8Array(width * height).fill(frames[0].clearKey);
  let played = -1;

  let undecoded = 0;

  async function play(index: number): Promise<void> {
    const entry = frames[index];
    const data = await volumes.read(file, entry.dataAt, entry.dataSize);
    read += data.length;

    if (entry.frameType === 0) {
      // A full frame replaces its rectangle outright, which is also how a SEQ
      // recovers from a scene change without sending every pixel twice.
      blit(canvas, width, height, entry, data);
      return;
    }

    const rleSize = Math.min(entry.rleSize, data.length);
    const decoded = decodeSeqDifference(
      canvas,
      data.subarray(0, rleSize),
      data.subarray(rleSize),
      entry,
    );
    // Left as it was, and counted. A difference frame that will not decode is
    // a frame this reader declines to invent, for the reason at the top.
    if (!decoded) undecoded++;
  }

  return {
    frameCount: frames.length,
    palette,
    width,
    height,
    get undecodedFrames() {
      return undecoded;
    },
    bytesRead: () => read,
    async frame(index: number) {
      if (index < 0 || index >= frames.length) return null;

      // Going backwards means starting again. Stated rather than hidden: the
      // alternative is keeping every frame, which for a two-megabyte SEQ is the
      // whole file in memory — the thing ADR 0021 exists to avoid.
      if (index < played) {
        canvas.fill(frames[0].clearKey);
        played = -1;
        undecoded = 0;
      }
      while (played < index) await play(++played);

      return {
        cel: {
          width,
          height,
          displaceX: 0,
          displaceY: 0,
          clearKey: frames[0].clearKey,
          pixels: canvas.slice(),
        },
        // The canvas *is* the screen, so a frame's own corner has already been
        // honoured by the decode. Handing back a corner here as well would
        // move every frame by its own offset a second time.
        left: 0,
        top: 0,
      };
    },
  };
}

/** A full frame's pixels, straight into the canvas at the frame's own corner. */
function blit(
  canvas: Uint8Array,
  width: number,
  height: number,
  entry: SeqFrameIndex,
  data: Uint8Array,
): void {
  for (let y = 0; y < entry.height; y++) {
    const row = entry.top + y;
    if (row < 0 || row >= height) continue;
    for (let x = 0; x < entry.width; x++) {
      const column = entry.left + x;
      if (column < 0 || column >= width) continue;
      canvas[row * width + column] = data[y * entry.width + x] ?? 0;
    }
  }
}

/**
 * A difference frame, decoded against what is already on the canvas.
 *
 * Returns false rather than a partial picture: a run that would leave the frame
 * or a literal stream that runs short means this is not the format as read
 * here, and the caller counts the frame instead of showing it.
 *
 * The rows are the *screen's*, offset by the frame's top, and the columns start
 * at the frame's left. Every skip therefore leaves whatever the previous frame
 * put there, which is the whole point of a difference frame.
 */
function decodeSeqDifference(
  canvas: Uint8Array,
  control: Uint8Array,
  literals: Uint8Array,
  entry: SeqFrameIndex,
): boolean {
  const stride = SEQ_SCREEN_WIDTH;
  const base = entry.top * stride;
  let row = 0;
  let column = entry.left;
  let literal = 0;
  let at = 0;

  /** One run of literals, bounds-checked both ways before anything is written. */
  const copy = (count: number): boolean => {
    if (count < 0) return false;
    const start = base + row * stride + column;
    if (row < 0 || row >= entry.height || start + count > canvas.length) return false;
    if (literal + count > literals.length) return false;
    canvas.set(literals.subarray(literal, literal + count), start);
    literal += count;
    return true;
  };

  while (at < control.length) {
    const op = control[at++];

    if ((op & 0xc0) === 0xc0) {
      const run = op & 0x3f;
      if (run === 0) {
        row++;
        column = entry.left;
      } else {
        column += run;
      }
      continue;
    }

    if (op & 0x80) {
      const run = op & 0x3f;
      if (run === 0) {
        // The rest of this row, which is how a frame says "and the remainder
        // differs" without counting it out.
        const rest = entry.width - (column - entry.left);
        if (!copy(rest)) return false;
        row++;
        column = entry.left;
      } else {
        if (!copy(run)) return false;
        column += run;
      }
      continue;
    }

    if (at >= control.length) return false;
    const count = ((op & 7) << 8) | control[at++];

    switch (op >> 3) {
      case 2:
        column += count;
        break;
      case 3:
        if (!copy(count)) return false;
        column += count;
        break;
      case 6: {
        // Whole rows, straight from the literal stream. Zero means "to the end
        // of the frame", which is how a frame that changes entirely is written.
        const rows = count === 0 ? entry.height - row : count;
        for (let index = 0; index < rows; index++) {
          column = entry.left;
          if (!copy(entry.width)) return false;
          row++;
        }
        column = entry.left;
        break;
      }
      case 7:
        row += count === 0 ? entry.height - row : count;
        column = entry.left;
        break;
      default:
        // A control byte outside the format as read here. Refused rather than
        // guessed at, which is the same answer `SciPicture` gives an operation
        // it does not know.
        return false;
    }
  }

  return true;
}
