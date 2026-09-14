/**
 * SEQ, VMD, DUK and Robot — and the line between them.
 *
 * `CONTEXT.md` already draws that line for SCUMM: SMUSH is "played by the
 * Engine rather than decoded to a resource". SCI has more on both sides of it,
 * and one thing that sits on neither.
 *
 * **Played, not held.** SEQ (SCI1.1's full-screen animation), VMD (SCI2's
 * video) and DUK (later SCI2.1 and SCI3) are SMUSH's situation exactly:
 * full-screen, played to the end or skipped, nothing a Project reconstructs.
 * Same treatment, no new vocabulary. This file is where a caller asks for one
 * without caring which it got.
 *
 * **Robot is not a video**, so it is not opened here. In Phantasmagoria the
 * protagonist *is* a Robot: pre-rendered actor footage composited into a Plane
 * with a priority, moving over a static background, occluded by scenery. It is
 * drawn into the scene, not played at the screen — a **screen-item kind**
 * (`SciRobot.ts`), which keeps the compositor the single place compositing
 * happens. `openSciVideo` identifies one and then refuses it by name, because
 * handing a Robot back through a "play this at the screen" interface is the
 * first step of the second drawing path #226 exists to prevent.
 *
 * **Streaming is not optional.** A 400 MB VMD is read through `VolumeReader` a
 * frame at a time (ADR 0021). Nobody wants it in memory; they want the next
 * frame — which is why nothing here returns a buffer of a whole file.
 *
 * ## A DUK is an AVI, which this had recorded the other way round
 *
 * `.duk` names the *codec*, not the container: the file opens `RIFF`, carries
 * an `AVI ` form, and holds Duck TrueMotion 1 video. ScummVM's `DuckPlayer`
 * hands one straight to `Video::AVIDecoder`, which is the evidence. A `DUCK`
 * four-character code does appear in the file — as the video stream's handler
 * inside the header list — and reading it as the file's first bytes meant no
 * real DUK was ever going to be identified. `SciAvi.ts` reads the container;
 * the codec it carries is the one video format in the family this project does
 * not turn into pixels, and that file says why at length.
 */

import type { VolumeReader } from '../../resource/VolumeReader.js';
import type { SciCel } from '../gfx/SciView.js';
import type { SciPaletteEntry } from '../gfx/sciPalette.js';
import { isAviFile, openSciAvi } from './SciAvi.js';
import { openSciSeq } from './SciSeq.js';
import { openSciVmd } from './SciVmd.js';

export type SciVideoFormat = 'seq' | 'vmd' | 'duk' | 'robot' | 'unknown';

/** What a video's header says, without any of its frames being read. */
export interface SciVideoInfo {
  format: SciVideoFormat;
  /** Frames the file declares, where its header carries a count. */
  frameCount: number;
  /** Bytes of header before the first frame. */
  headerSize: number;
  width: number;
  height: number;
  /** Whether this is composited into a Plane rather than played at the screen. */
  isScreenItem: boolean;
}

/** Robot's own magic: a header size, then `SOL\0`. */
const ROBOT_SIGNATURE = [0x53, 0x4f, 0x4c, 0x00];

/** The header length every VMD Sierra shipped declares. */
const VMD_HEADER_LENGTH = 0x032e;

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

/**
 * Identifies a video from its first bytes.
 *
 * Sixty-four bytes are enough for every format here, which is the point: a
 * caller finds out what it has, and how many frames, without the file being
 * read. A 400 MB VMD costs one range read to identify.
 *
 * Read from the real demos rather than from a specification: Lighthouse's
 * `.RBT` files open `16 00 53 4f 4c 00`, Gabriel Knight's `.SEQ` files with a
 * frame count, and RAMA's `.VMD` files with a header size of `0x032e`.
 */
export function identifySciVideo(head: Uint8Array): SciVideoInfo {
  const unknown: SciVideoInfo = {
    format: 'unknown',
    frameCount: 0,
    headerSize: 0,
    width: 0,
    height: 0,
    isScreenItem: false,
  };
  if (head.length < 8) return unknown;

  // Robot: a header size, then `SOL\0`. Checked before anything else because
  // its first word is a plausible header size for the others too.
  if (ROBOT_SIGNATURE.every((byte, index) => head[2 + index] === byte)) {
    return {
      format: 'robot',
      // The frame count sits after the version and the audio-block size.
      frameCount: u16(head, 14),
      headerSize: u16(head, 0),
      width: 0,
      height: 0,
      // The whole architectural claim of #226, as a field: a Robot goes
      // through the compositor as a screen item, sorted and occluded like a
      // View cel, rather than through a drawing path of its own.
      isScreenItem: true,
    };
  }

  // A DUK is a RIFF/AVI, and so is the `.avi` a `kShowMovie` names. Checked
  // before VMD and SEQ because both of those identify on a plain number, and
  // `RIFF` is a real magic that should win over a plausible one.
  if (isAviFile(head)) {
    return {
      format: 'duk',
      // The frame count is in the main header inside the header list, which is
      // further in than this window promises. `openSciAvi` reads it properly.
      frameCount: 0,
      headerSize: 12,
      width: 0,
      height: 0,
      isScreenItem: false,
    };
  }

  // VMD: a header size of 0x032e, which is the one thing every VMD shares.
  const headerSize = u16(head, 0);
  if (headerSize === VMD_HEADER_LENGTH) {
    return {
      format: 'vmd',
      frameCount: u16(head, 6),
      headerSize: headerSize + 2,
      width: u16(head, 12),
      height: u16(head, 14),
      isScreenItem: false,
    };
  }

  // SEQ has no magic at all — a frame count and then the frames. So it is what
  // is left, and only when the count is plausible: claiming SEQ for anything
  // unrecognised would turn "this is a format we do not read" into "this is a
  // SEQ with sixty thousand frames".
  const frames = u16(head, 0);
  if (frames > 0 && frames < 4096) {
    return {
      format: 'seq',
      frameCount: frames,
      headerSize: 2,
      width: 0,
      height: 0,
      isScreenItem: false,
    };
  }

  return unknown;
}

/**
 * One frame of a video, in whatever the format could give.
 *
 * A single shape for three containers, because a player should not branch on
 * which one it opened. `cel` is null for a frame whose pixels this project does
 * not decode — the DUK case, and only that case — and the frame is counted in
 * `undecodedFrames` so a caller can say so rather than show a blank screen and
 * call it playing.
 */
export interface SciVideoFrame {
  index: number;
  cel: SciCel | null;
  /** Where the frame goes on screen, for a format that says. */
  x: number;
  y: number;
  /** A palette this frame changed, where it changed one. */
  palette: SciPaletteEntry[] | null;
  /** Audio that arrived with this frame, undecoded, in order. */
  audio: Uint8Array[];
}

/**
 * A video opened for playing, without being read.
 *
 * `frame` fetches one, which for a VMD is a range read of a few kilobytes out
 * of a file that may be hundreds of megabytes — the case ADR 0021 exists for,
 * and the reason this is a reader rather than bytes.
 */
export interface SciVideoStream {
  info: SciVideoInfo;
  /** The palette the file opens with, where it carries one. */
  palette: SciPaletteEntry[];
  /** Frames per second the file intends. */
  frameRate: number;
  /** Frames this project could not turn into pixels. */
  undecodedFrames: number;
  /** One frame, played forward from wherever the stream is. */
  frame(index: number): Promise<SciVideoFrame | null>;
  /** How many bytes have been read so far, for the memory accounting. */
  bytesRead(): number;
}

/**
 * Opens a played video through the Volume reader.
 *
 * Returns null for a Robot as well as for a file in no format it knows, and
 * the difference is deliberate rather than sloppy: a Robot is not played at the
 * screen, and `openSciRobot` is where one is opened. See the note at the top.
 */
export async function openSciVideo(
  volumes: VolumeReader,
  file: string,
): Promise<SciVideoStream | null> {
  const head = await volumes.read(file, 0, 64);
  const identified = identifySciVideo(head);

  if (identified.format === 'seq') {
    const seq = await openSciSeq(volumes, file);
    if (!seq) return null;
    return {
      info: { ...identified, width: seq.width, height: seq.height, frameCount: seq.frameCount },
      palette: seq.palette,
      // SEQ carries no rate of its own; the game passes one to `kShowMovie` in
      // ticks, so a player is told rather than asking.
      frameRate: 0,
      get undecodedFrames() {
        return seq.undecodedFrames;
      },
      bytesRead: () => seq.bytesRead(),
      async frame(index) {
        const frame = await seq.frame(index);
        if (!frame) return null;
        return { index, cel: frame.cel, x: frame.left, y: frame.top, palette: null, audio: [] };
      },
    };
  }

  if (identified.format === 'vmd') {
    const vmd = await openSciVmd(volumes, file);
    if (!vmd) return null;
    return {
      info: {
        ...identified,
        width: vmd.info.width,
        height: vmd.info.height,
        frameCount: vmd.info.frameCount,
      },
      palette: vmd.info.palette,
      frameRate: vmd.info.frameRate,
      get undecodedFrames() {
        return vmd.undecodedFrames;
      },
      bytesRead: () => vmd.bytesRead(),
      async frame(index) {
        const frame = await vmd.frame(index);
        if (!frame) return null;
        return {
          index,
          cel: frame.cel,
          x: frame.x,
          y: frame.y,
          palette: frame.palette,
          audio: frame.audio,
        };
      },
    };
  }

  if (identified.format === 'duk') {
    const avi = await openSciAvi(volumes, file);
    if (!avi) return null;
    let undecoded = 0;
    return {
      info: {
        ...identified,
        width: avi.info.width,
        height: avi.info.height,
        frameCount: avi.info.frameCount,
      },
      palette: [],
      frameRate: avi.info.frameRate,
      get undecodedFrames() {
        return undecoded;
      },
      bytesRead: () => avi.bytesRead(),
      async frame(index) {
        const frame = await avi.frame(index);
        if (!frame) return null;
        // The container is read and the codec is not. Counted rather than
        // handed back as a blank cel, so "playing" never means "showing
        // nothing while the audio runs".
        if (frame.video) undecoded++;
        return { index, cel: null, x: 0, y: 0, palette: null, audio: frame.audio };
      },
    };
  }

  return null;
}

/**
 * Whether a sequence is one the scripts drive rather than play to the end.
 *
 * `CONTEXT.md`'s `Interactive sequence`, checked as #226 asks. The test is
 * whether the game's scripts keep running while it is on screen, and a Robot is
 * the whole family's example: it is composited into a Plane the scripts are
 * still changing, so it is interactive by construction. SEQ, VMD and DUK are
 * played at the screen and are not.
 */
export function isInteractiveSequence(info: SciVideoInfo): boolean {
  return info.isScreenItem;
}
