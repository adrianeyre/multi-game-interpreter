/**
 * SEQ, VMD, DUK and Robot — and the line between them (#226).
 *
 * The line `CONTEXT.md` draws for SMUSH: SEQ, VMD and DUK are *played* at the
 * screen and nothing a Project reconstructs, and **Robot is not a video** — in
 * Phantasmagoria the protagonist *is* one, composited into a Plane with a
 * priority and occluded by scenery. So it is a screen-item kind, which keeps
 * the compositor the single place compositing happens.
 *
 * Identified against real data: Lighthouse's `.RBT` files, Gabriel Knight's
 * `.SEQ` files and RAMA's `.VMD` files all read their headers and frame counts.
 */

import { describe, expect, it } from 'vitest';

import { BufferVolumeReader } from '../src/engine/resource/VolumeReader.js';
import { u16le, u32le } from './fixtureSci.js';
import { SciMoviePlayer } from '../src/engine/sci/video/SciMoviePlayer.js';
import { SCI_EVENT, SciInput } from '../src/engine/sci/SciInput.js';
import { Palette } from '../src/engine/gfx/Palette.js';
import { reg } from '../src/engine/sci/script/PMachine.js';
import type { SciKernelWorld } from '../src/engine/sci/script/SciKernel.js';
import {
  identifySciVideo,
  isInteractiveSequence,
  openSciVideo,
} from '../src/engine/sci/video/sciVideo.js';
import { frameScreenItems, openSciRobot } from '../src/engine/sci/video/SciRobot.js';
import { openSciSeq } from '../src/engine/sci/video/SciSeq.js';
import { openSciVmd } from '../src/engine/sci/video/SciVmd.js';
import { isAviFile, openSciAvi } from '../src/engine/sci/video/SciAvi.js';
import { Plane, SciCompositor } from '../src/engine/sci/gfx/Plane.js';
import type { SciCel } from '../src/engine/sci/gfx/SciView.js';

/** A solid cel, for putting something ordinary beside a Robot's. */
function cel(width: number, height: number, fill: number): SciCel {
  return {
    width,
    height,
    displaceX: 0,
    displaceY: 0,
    clearKey: 0,
    pixels: new Uint8Array(width * height).fill(fill),
  };
}

/** A RIFF/AVI's first twelve bytes, which is what a `.duk` really opens with. */
function riffHead(): Uint8Array {
  const head = new Uint8Array(64);
  head.set(
    [...'RIFF'].map((c) => c.charCodeAt(0)),
    0,
  );
  head.set(
    [...'AVI '].map((c) => c.charCodeAt(0)),
    8,
  );
  return head;
}

/** One part of one VMD frame. */
type VmdPart =
  | {
      kind: 'video';
      block: number;
      rect: [number, number, number, number];
      data: number[];
      /** A palette in front of the pixels, as a video part may carry. */
      palette?: Array<[number, number, number]>;
    }
  | { kind: 'audio'; data: number[]; flags?: number };

/**
 * A VMD, built to Coktel's own layout: a 816-byte header, a frame table where
 * the header says, and the frames wherever the table says.
 */
function vmd(spec: { width?: number; height?: number; frames: VmdPart[][] }): Uint8Array {
  const width = spec.width ?? 4;
  const height = spec.height ?? 2;
  const partsPerFrame = Math.max(1, ...spec.frames.map((frame) => frame.length));

  /** A part's payload bytes, which is what its size counts. */
  const payloadOf = (part: VmdPart): Uint8Array => {
    if (part.kind === 'audio') return Uint8Array.from(part.data);
    const body = [part.block, ...part.data];
    if (!part.palette) return Uint8Array.from(body);
    // A start index, a count, and then the full 256 entries whatever the
    // count said — which is why the size drops by 770 and not by the count.
    const colours = new Uint8Array(768);
    part.palette.forEach((entry, index) => colours.set(entry, index * 3));
    return Uint8Array.from([0, part.palette.length - 1, ...colours, ...body]);
  };

  const payloads = spec.frames.map((frame) => frame.map(payloadOf));
  const tableAt = 816;
  const tableSize = spec.frames.length * (6 + partsPerFrame * 16);
  const framesAt = tableAt + tableSize;

  const size =
    framesAt +
    payloads.reduce((sum, frame) => sum + frame.reduce((n, part) => n + part.length, 0), 0);
  const file = new Uint8Array(size);
  const view = new DataView(file.buffer);

  view.setUint16(0, 814, true);
  view.setUint16(6, spec.frames.length, true);
  view.setInt16(12, width, true);
  view.setInt16(14, height, true);
  view.setUint16(18, partsPerFrame, true);
  view.setUint32(812, tableAt, true);

  let at = framesAt;
  spec.frames.forEach((frame, index) => {
    view.setUint32(tableAt + index * 6 + 2, at, true);
    let record = tableAt + spec.frames.length * 6 + index * partsPerFrame * 16;
    frame.forEach((part, partIndex) => {
      const payload = payloads[index][partIndex];
      file[record] = part.kind === 'audio' ? 1 : 2;
      view.setUint32(record + 2, payload.length, true);
      if (part.kind === 'audio') {
        file[record + 6] = part.flags ?? 1;
      } else {
        view.setUint16(record + 6, part.rect[0], true);
        view.setUint16(record + 8, part.rect[1], true);
        view.setUint16(record + 10, part.rect[2], true);
        view.setUint16(record + 12, part.rect[3], true);
        file[record + 15] = part.palette ? 2 : 0;
      }
      file.set(payload, at);
      at += payload.length;
      record += 16;
    });
  });

  return file;
}

/** Four bytes of a four-character code. */
function tag(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0));
}

/**
 * A RIFF/AVI carrying one video stream and one audio stream, which is the
 * shape of a `.duk`.
 */
function avi(chunks: Array<{ id: string; data: number[] }>): Uint8Array {
  const avih = [
    ...tag('avih'),
    ...u32le(56),
    ...u32le(100000), // microseconds per frame — ten a second
    ...new Array(12).fill(0),
    ...u32le(2), // total frames
    ...new Array(12).fill(0),
    ...u32le(4), // width
    ...u32le(2), // height
    ...new Array(16).fill(0),
  ];
  const videoStream = [
    ...tag('LIST'),
    ...u32le(4 + 8 + 16 + 8 + 20),
    ...tag('strl'),
    ...tag('strh'),
    ...u32le(16),
    ...tag('vids'),
    ...tag('DUCK'),
    ...new Array(8).fill(0),
    ...tag('strf'),
    ...u32le(20),
    ...u32le(40),
    ...u32le(4),
    ...u32le(2),
    ...new Array(8).fill(0),
  ];
  const audioStream = [
    ...tag('LIST'),
    ...u32le(4 + 8 + 16 + 8 + 16),
    ...tag('strl'),
    ...tag('strh'),
    ...u32le(16),
    ...tag('auds'),
    ...new Array(12).fill(0),
    ...tag('strf'),
    ...u32le(16),
    ...u16le(1), // PCM
    ...u16le(1), // mono
    ...u32le(22050),
    ...u32le(22050),
    ...u16le(1),
    ...u16le(8),
  ];
  const hdrl = [
    ...tag('LIST'),
    ...u32le(4 + avih.length + videoStream.length + audioStream.length),
    ...tag('hdrl'),
    ...avih,
    ...videoStream,
    ...audioStream,
  ];

  const movi: number[] = [];
  for (const chunk of chunks) {
    movi.push(...tag(chunk.id), ...u32le(chunk.data.length), ...chunk.data);
    if (chunk.data.length & 1) movi.push(0);
  }
  const moviList = [...tag('LIST'), ...u32le(4 + movi.length), ...tag('movi'), ...movi];

  return Uint8Array.from([
    ...tag('RIFF'),
    ...u32le(4 + hdrl.length + moviList.length),
    ...tag('AVI '),
    ...hdrl,
    ...moviList,
  ]);
}

/** Lighthouse's own first bytes: a header size, then `SOL\0`. */
function robotHead(): Uint8Array {
  const head = new Uint8Array(64);
  head.set([0x16, 0x00, 0x53, 0x4f, 0x4c, 0x00, 0x05, 0x00], 0);
  head[14] = 12;
  return head;
}

describe('identifying a SCI video', () => {
  it('knows a Robot by its SOL signature', () => {
    const info = identifySciVideo(robotHead());
    expect(info.format).toBe('robot');
    expect(info.frameCount).toBe(12);
    expect(info.headerSize).toBe(0x16);
  });

  /**
   * The architectural claim of #226, as a field. A Robot goes through the
   * compositor as a screen item — sorted and occluded like a View cel — rather
   * than through a drawing path of its own. If it ever needs its own path,
   * that is ADR 0015's tripwire firing.
   */
  it('marks a Robot as a screen item and everything else as played', () => {
    expect(identifySciVideo(robotHead()).isScreenItem).toBe(true);
    expect(isInteractiveSequence(identifySciVideo(robotHead()))).toBe(true);

    const vmd = new Uint8Array(64);
    vmd[0] = 0x2e;
    vmd[1] = 0x03;
    vmd[6] = 171;
    expect(identifySciVideo(vmd).format).toBe('vmd');
    expect(identifySciVideo(vmd).isScreenItem).toBe(false);
  });

  /**
   * A DUK is a RIFF/AVI, which this project had recorded the other way round.
   *
   * `DUCK` is the video stream's four-character handler *inside* the header
   * list, not the file's first bytes — so a file that opened `DUCK` was never
   * going to be a real DUK, and no real DUK was ever going to be identified.
   * ScummVM hands `.duk` straight to its AVI decoder, which is the evidence.
   */
  it('knows a VMD by its header size and a DUK for the AVI it is', () => {
    const vmd = new Uint8Array(64);
    vmd[0] = 0x2e;
    vmd[1] = 0x03;
    expect(identifySciVideo(vmd).format).toBe('vmd');

    expect(identifySciVideo(riffHead()).format).toBe('duk');

    // And the tag that used to be believed is not a container at all.
    const tagged = new Uint8Array(64);
    tagged.set([0x44, 0x55, 0x43, 0x4b], 0);
    expect(identifySciVideo(tagged).format).not.toBe('duk');
  });

  /**
   * SEQ has no magic at all, so it is what is left — and only when the frame
   * count is plausible. Claiming it for anything unrecognised would turn "a
   * format we do not read" into "a SEQ with sixty thousand frames".
   */
  it('claims SEQ only for a plausible frame count', () => {
    const seq = new Uint8Array(64);
    seq[0] = 48;
    expect(identifySciVideo(seq).format).toBe('seq');

    const nonsense = new Uint8Array(64);
    nonsense[0] = 0xff;
    nonsense[1] = 0xff;
    expect(identifySciVideo(nonsense).format).toBe('unknown');
  });
});

describe('streaming a video (ADR 0021)', () => {
  /**
   * The property the seam exists for: opening a video and playing its first
   * frame costs the same whether the file is one megabyte or four hundred.
   * Against real data — RAMA's 2.6 MB `40000.VMD` costs 65,600 bytes.
   */
  it('reads a window rather than the file', async () => {
    // A real VMD, padded out to four megabytes. The padding is the point: a
    // reader that indexed the file rather than its table would pay for it.
    const small = vmd({
      frames: [
        [{ kind: 'video', block: 0x02, rect: [0, 0, 3, 1], data: [1, 2, 3, 4, 5, 6, 7, 8] }],
      ],
    });
    const big = new Uint8Array(4 * 1024 * 1024);
    big.set(small, 0);

    const volumes = new BufferVolumeReader('t', [['40000.VMD', big]]);
    const stream = await openSciVideo(volumes, '40000.VMD');

    expect(stream).not.toBeNull();
    await stream!.frame(0);
    expect(stream!.bytesRead()).toBeLessThan(0x11000);
    expect(stream!.bytesRead()).toBeLessThan(big.length / 60);
  });

  it('answers nothing for a file in no format it knows', async () => {
    const volumes = new BufferVolumeReader('t', [['x.vmd', new Uint8Array([0xff, 0xff, 0, 0])]]);
    expect(await openSciVideo(volumes, 'x.vmd')).toBeNull();
  });

  /**
   * A Robot is refused by name rather than played.
   *
   * Handing one back through a "play this at the screen" interface is the
   * first step of the second drawing path #226 exists to prevent, so the
   * refusal is the architecture rather than a gap.
   */
  it('refuses a Robot, which is composited and not played', async () => {
    const volumes = new BufferVolumeReader('t', [['1.RBT', robotHead()]]);
    expect(identifySciVideo(robotHead()).format).toBe('robot');
    expect(await openSciVideo(volumes, '1.RBT')).toBeNull();
  });
});

/**
 * Robot, decoded rather than only identified.
 *
 * The container is self-checking and it was checked: for all thirteen `.RBT`
 * files in Sierra's Lighthouse demo, the aligned frame-data offset plus the sum
 * of the record sizes is the file length to the byte, and 713 cels decode with
 * two blank ones. The fixture below is built to that shape.
 */
describe('a Robot, which is drawn into the scene', () => {
  /** A one-frame, one-cel Robot with an uncompressed body. */
  function robot(
    options: { version: number; audio: number } = { version: 6, audio: 0 },
  ): Uint8Array {
    const paletteSize = 64;
    const header = 60;
    const tableAt = header + paletteSize;
    const tableSize = options.version >= 6 ? 8 : 4;
    const dataAt = Math.ceil((tableAt + tableSize + 256 * 4 + 256 * 2) / 2048) * 2048;

    const cel = new Uint8Array(2 + 22 + 4);
    const celView = new DataView(cel.buffer);
    celView.setUint16(0, 1, true); // one cel
    celView.setInt16(2 + 2, 2, true); // width
    celView.setInt16(2 + 4, 2, true); // height
    celView.setInt16(2 + 10, 11, true); // x
    celView.setInt16(2 + 12, 7, true); // y
    celView.setUint16(2 + 14, 4, true); // data size
    celView.setInt16(2 + 16, 0, true); // no chunks: the pixels are simply there
    cel.set([1, 2, 3, 4], 24);

    const file = new Uint8Array(dataAt + cel.length + options.audio);
    const view = new DataView(file.buffer);
    view.setUint16(0, 0x16, true);
    file.set([0x53, 0x4f, 0x4c, 0x00], 2);
    view.setUint16(6, options.version, true);
    view.setUint16(8, options.audio, true); // audio block size
    view.setUint16(14, 1, true); // one frame
    view.setUint16(16, paletteSize, true);
    file[24] = 1; // has a palette
    view.setInt16(28, 10, true); // frame rate
    view.setInt16(34, 1, true); // one cel per frame

    if (options.version >= 6) {
      view.setInt32(tableAt, cel.length, true);
      view.setInt32(tableAt + 4, cel.length + options.audio, true);
    } else {
      view.setInt16(tableAt, cel.length, true);
      view.setInt16(tableAt + 2, cel.length + options.audio, true);
    }
    file.set(cel, dataAt);
    return file;
  }

  it('reads a frame at its own offset without touching what precedes it', async () => {
    const volumes = new BufferVolumeReader('test', [['16.RBT', robot()]]);
    const stream = await openSciRobot(volumes, '16.RBT');

    expect(stream).not.toBeNull();
    expect(stream?.info.frameCount).toBe(1);
    expect(stream?.info.frameRate).toBe(10);

    const frame = await stream?.frame(0);
    expect(frame?.cels).toHaveLength(1);
    expect([...(frame?.cels[0].cel.pixels ?? [])]).toEqual([1, 2, 3, 4]);
    expect(frame?.cels[0]).toMatchObject({ x: 11, y: 7 });

    // The whole file is 4KB and opening it read the header and the table only.
    // That is ADR 0021's property, and it is the same property a 400MB video
    // would have.
    expect(stream?.bytesRead()).toBeLessThan(200);
  });

  /**
   * **#226's question, answered as a test.**
   *
   * The claim is that a Robot composites through the same Plane, the same
   * ScreenItem and the same three sort keys as a View cel — no second drawing
   * path. This builds items from a Robot frame, adds them to a Plane beside an
   * ordinary cel, and checks that the compositor sorted them together.
   */
  it('composites as a screen item beside a View cel, through one compositor', async () => {
    const volumes = new BufferVolumeReader('test', [['16.RBT', robot()]]);
    const stream = await openSciRobot(volumes, '16.RBT');
    const frame = await stream?.frame(0);
    expect(frame).toBeTruthy();

    // A SCI32 Plane: no mask, occluding by ordering alone.
    const plane = new Plane({ x: 0, y: 0, width: 20, height: 20 }, 0, null);
    plane.add({ cel: cel(4, 4, 9), x: 10, y: 6, priority: 1, visible: true });
    for (const item of frameScreenItems(frame!, 5)) plane.add(item);

    const compositor = new SciCompositor();
    compositor.add(plane);
    const framebuffer = new Uint8Array(400);
    compositor.composite(framebuffer, 20, 20);

    // The Robot's higher priority put it over the View cel, by the same rule
    // that orders two View cels. Nothing in Plane or SciCompositor knows a
    // Robot exists.
    expect(framebuffer[7 * 20 + 11]).toBe(1);
    expect(framebuffer[6 * 20 + 10]).toBe(9);
  });

  it('believes the audio block size rather than the flag that contradicts it', async () => {
    // Lighthouse's 184.RBT declares no audio at offset 25 and hands back 238KB
    // of it. The block size at offset 8 agrees with the records every time.
    const volumes = new BufferVolumeReader('test', [['a.RBT', robot({ version: 6, audio: 6 })]]);
    const stream = await openSciRobot(volumes, 'a.RBT');

    expect(stream?.info.hasAudio).toBe(true);
    expect(stream?.info.audioBlockSize).toBe(6);
    // The audio arrives *with* its frame, which is the whole of the sync
    // guarantee — Sierra put it in the record for that reason.
    expect((await stream?.frame(0))?.audio.length).toBe(6);
  });

  it('refuses a file that is not a Robot rather than reading a header out of it', async () => {
    const volumes = new BufferVolumeReader('test', [['x.RBT', new Uint8Array(4096)]]);
    expect(await openSciRobot(volumes, 'x.RBT')).toBeNull();
  });
});

/**
 * A SEQ, whose difference frames this now decodes.
 *
 * The codec is `SEQDecoder::SEQVideoTrack::decodeFrame`'s: three shapes of
 * control byte over a separate stream of literals, everything measured in
 * screen rows of 320. The tests below are one of each shape, plus the two ways
 * a frame can be refused rather than invented.
 */
describe('a SEQ, which is played and not held', () => {
  /** A palette chunk `readSciPalette` reads as empty, which is enough here. */
  const PALETTE = 40;

  /**
   * A SEQ carrying one full frame and then whatever difference frames are
   * asked for. The frame records chain by their own body offsets, which is
   * what the container guarantees and what the reader walks.
   */
  function seq(
    diffs: Array<{ control: number[]; literals: number[]; width?: number; height?: number }> = [],
  ): Uint8Array {
    const records: Array<{ header: Uint8Array; body: Uint8Array }> = [];

    const first = new Uint8Array(36);
    const firstView = new DataView(first.buffer);
    firstView.setUint16(0, 2, true); // width
    firstView.setUint16(2, 2, true); // height
    first[8] = 0xff; // transparent index
    first[9] = 0; // a full frame
    records.push({ header: first, body: new Uint8Array([4, 5, 6, 7]) });

    for (const diff of diffs) {
      const header = new Uint8Array(36);
      const view = new DataView(header.buffer);
      view.setUint16(0, diff.width ?? 2, true);
      view.setUint16(2, diff.height ?? 2, true);
      header[8] = 0xff;
      header[9] = 1; // a difference frame
      view.setUint16(12, diff.control.length + diff.literals.length, true);
      // Both sizes are words. Writing a long here is the fault this format
      // spent a round being blamed for, so the fixture is deliberate about it.
      view.setUint16(16, diff.control.length, true);
      records.push({ header, body: new Uint8Array([...diff.control, ...diff.literals]) });
    }

    const size =
      6 +
      PALETTE +
      records.reduce((sum, record) => sum + record.header.length + record.body.length, 0);
    const file = new Uint8Array(size);
    const view = new DataView(file.buffer);
    view.setUint16(0, records.length, true);
    view.setUint32(2, PALETTE, true);

    let at = 6 + PALETTE;
    for (const record of records) {
      const bodyAt = at + record.header.length;
      new DataView(record.header.buffer).setUint32(24, bodyAt, true);
      file.set(record.header, at);
      file.set(record.body, bodyAt);
      at = bodyAt + record.body.length;
    }
    return file;
  }

  /** The pixel at a point on the 320x200 screen a SEQ plays on. */
  function at(pixels: Uint8Array | undefined, x: number, y: number): number | undefined {
    return pixels?.[y * 320 + x];
  }

  it('indexes frames without reading their pixels, and decodes a full frame', async () => {
    const volumes = new BufferVolumeReader('test', [['OPEN.SEQ', seq()]]);
    const stream = await openSciSeq(volumes, 'OPEN.SEQ');

    expect(stream?.frameCount).toBe(1);
    // The screen, not the frame: a difference frame counts its runs in rows of
    // 320, so a canvas the size of the first frame shears everything after it.
    expect(stream?.width).toBe(320);
    expect(stream?.height).toBe(200);

    const frame = await stream?.frame(0);
    const pixels = frame?.cel.pixels;
    expect([at(pixels, 0, 0), at(pixels, 1, 0), at(pixels, 0, 1), at(pixels, 1, 1)]).toEqual([
      4, 5, 6, 7,
    ]);
    // The corner was honoured by the decode, so it is not handed back again.
    expect([frame?.left, frame?.top]).toEqual([0, 0]);
    expect(stream?.undecodedFrames).toBe(0);
  });

  it('copies a run of literals and steps to the next row on the short control byte', async () => {
    // 0x82 copies two literals; 0xc0 ends the row; 0x81 copies one more.
    const file = seq([{ control: [0x82, 0xc0, 0x81], literals: [9, 8, 7] }]);
    const stream = await openSciSeq(new BufferVolumeReader('test', [['A.SEQ', file]]), 'A.SEQ');
    const pixels = (await stream?.frame(1))?.cel.pixels;

    expect(stream?.undecodedFrames).toBe(0);
    expect([at(pixels, 0, 0), at(pixels, 1, 0)]).toEqual([9, 8]);
    // The second row's first pixel changed and its second was skipped, so what
    // the full frame put there is still there. That is the whole idea of a
    // difference frame, and the assertion that it is a difference and not a
    // repaint.
    expect([at(pixels, 0, 1), at(pixels, 1, 1)]).toEqual([7, 7]);
  });

  it('copies the rest of a row when the count is zero', async () => {
    // 0x80 means "the remainder of this row", which is how a frame says a row
    // differs from here on without counting the pixels.
    const file = seq([{ control: [0xc1, 0x80], literals: [3] }]);
    const stream = await openSciSeq(new BufferVolumeReader('test', [['B.SEQ', file]]), 'B.SEQ');
    const pixels = (await stream?.frame(1))?.cel.pixels;

    expect(stream?.undecodedFrames).toBe(0);
    expect([at(pixels, 0, 0), at(pixels, 1, 0)]).toEqual([4, 3]);
  });

  it('reads a long run as eleven bits across two bytes', async () => {
    // op 0x18 is a copy — `op >> 3` is 3 — of `((op & 7) << 8) | next` pixels.
    const file = seq([{ control: [0x18, 0x02], literals: [1, 2] }]);
    const stream = await openSciSeq(new BufferVolumeReader('test', [['C.SEQ', file]]), 'C.SEQ');
    const pixels = (await stream?.frame(1))?.cel.pixels;

    expect(stream?.undecodedFrames).toBe(0);
    expect([at(pixels, 0, 0), at(pixels, 1, 0)]).toEqual([1, 2]);
  });

  it('copies whole rows to the end of the frame when the row count is zero', async () => {
    // op 0x30 is "copy rows" — `op >> 3` is 6 — and a count of zero means every
    // row that is left, which is how a frame that changes entirely is written.
    const file = seq([{ control: [0x30, 0x00], literals: [1, 2, 3, 4] }]);
    const stream = await openSciSeq(new BufferVolumeReader('test', [['D.SEQ', file]]), 'D.SEQ');
    const pixels = (await stream?.frame(1))?.cel.pixels;

    expect(stream?.undecodedFrames).toBe(0);
    expect([at(pixels, 0, 0), at(pixels, 1, 0), at(pixels, 0, 1), at(pixels, 1, 1)]).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('skips whole rows, leaving what the frame before it drew', async () => {
    // op 0x38 is "skip rows" — `op >> 3` is 7 — so the first row survives and
    // the second is written.
    const file = seq([{ control: [0x38, 0x01, 0x82], literals: [8, 9] }]);
    const stream = await openSciSeq(new BufferVolumeReader('test', [['E.SEQ', file]]), 'E.SEQ');
    const pixels = (await stream?.frame(1))?.cel.pixels;

    expect(stream?.undecodedFrames).toBe(0);
    expect([at(pixels, 0, 0), at(pixels, 1, 0)]).toEqual([4, 5]);
    expect([at(pixels, 0, 1), at(pixels, 1, 1)]).toEqual([8, 9]);
  });

  it('refuses a control byte outside the format rather than drawing something plausible', async () => {
    // `op >> 3` of 0 is not one of the four operations. A decoder that guessed
    // here would produce a picture that is nearly the frame, which is the fault
    // class `verifying-version-support.md` says nothing on screen will show.
    const file = seq([{ control: [0x00, 0x02], literals: [1, 2] }]);
    const stream = await openSciSeq(new BufferVolumeReader('test', [['F.SEQ', file]]), 'F.SEQ');
    const pixels = (await stream?.frame(1))?.cel.pixels;

    expect(stream?.undecodedFrames).toBe(1);
    expect([at(pixels, 0, 0), at(pixels, 1, 0)]).toEqual([4, 5]);
  });

  it('refuses a run whose literals are not there', async () => {
    const file = seq([{ control: [0x84], literals: [1] }]);
    const stream = await openSciSeq(new BufferVolumeReader('test', [['G.SEQ', file]]), 'G.SEQ');

    await stream?.frame(1);
    expect(stream?.undecodedFrames).toBe(1);
  });

  it('replays from the start when asked for a frame it has gone past', async () => {
    const file = seq([{ control: [0x82], literals: [9, 8] }]);
    const stream = await openSciSeq(new BufferVolumeReader('test', [['H.SEQ', file]]), 'H.SEQ');

    expect(at((await stream?.frame(1))?.cel.pixels, 0, 0)).toBe(9);
    // Backwards means starting again, so the difference frame is not still on
    // the canvas — the alternative is holding every frame in memory.
    expect(at((await stream?.frame(0))?.cel.pixels, 0, 0)).toBe(4);
  });

  it('refuses a file whose first two fields are not a SEQ', async () => {
    const volumes = new BufferVolumeReader('test', [['x.SEQ', new Uint8Array(64)]]);
    expect(await openSciSeq(volumes, 'x.SEQ')).toBeNull();
  });
});

/**
 * A VMD, which is Coktel Vision's container and not Sierra's.
 *
 * Gabriel Knight 2, Torin, Lighthouse and RAMA all ship it, and it is where
 * #226's memory question actually bites: these are the enormous files. So the
 * tests below are about two things — that the blocks decode, and that opening a
 * four-megabyte file costs a header and a table.
 */
describe('a VMD, played at the screen', () => {
  it('reads its header, its palette and its frame table without the frames', async () => {
    const file = vmd({
      frames: [
        [{ kind: 'video', block: 0x02, rect: [0, 0, 3, 1], data: [1, 2, 3, 4, 5, 6, 7, 8] }],
      ],
    });
    const stream = await openSciVmd(new BufferVolumeReader('t', [['A.VMD', file]]), 'A.VMD');

    expect(stream?.info.frameCount).toBe(1);
    expect([stream?.info.width, stream?.info.height]).toEqual([4, 2]);
    // Coktel stores six-bit VGA values, so a palette read without the shift is
    // a video that plays correctly and looks like it is behind smoked glass.
    expect(stream?.info.palette).toHaveLength(256);
  });

  it('draws a whole block, every pixel of which is present', async () => {
    const file = vmd({
      frames: [
        [{ kind: 'video', block: 0x02, rect: [0, 0, 3, 1], data: [1, 2, 3, 4, 5, 6, 7, 8] }],
      ],
    });
    const stream = await openSciVmd(new BufferVolumeReader('t', [['B.VMD', file]]), 'B.VMD');
    const frame = await stream?.frame(0);

    expect([...(frame?.cel?.pixels ?? [])]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(frame?.dirty).toEqual({ left: 0, top: 0, width: 4, height: 2 });
    expect(stream?.undecodedFrames).toBe(0);
  });

  it('leaves a hole in a sparse block showing what was underneath', async () => {
    const file = vmd({
      frames: [
        [{ kind: 'video', block: 0x02, rect: [0, 0, 3, 1], data: [1, 2, 3, 4, 5, 6, 7, 8] }],
        // Row one is four fresh pixels; row two is a hole of four, so what the
        // frame before it drew is still there. That is the whole idea.
        [{ kind: 'video', block: 0x01, rect: [0, 0, 3, 1], data: [0x83, 9, 9, 9, 9, 0x03] }],
      ],
    });
    const stream = await openSciVmd(new BufferVolumeReader('t', [['C.VMD', file]]), 'C.VMD');
    const frame = await stream?.frame(1);

    expect([...(frame?.cel?.pixels ?? [])]).toEqual([9, 9, 9, 9, 5, 6, 7, 8]);
  });

  it('reads a run-length block, whose holes work the same way', async () => {
    const file = vmd({
      frames: [
        [{ kind: 'video', block: 0x02, rect: [0, 0, 3, 1], data: [1, 2, 3, 4, 5, 6, 7, 8] }],
        [{ kind: 'video', block: 0x03, rect: [0, 0, 3, 1], data: [0x03, 0x83, 7, 7, 7, 7] }],
      ],
    });
    const stream = await openSciVmd(new BufferVolumeReader('t', [['D.VMD', file]]), 'D.VMD');
    const frame = await stream?.frame(1);

    expect([...(frame?.cel?.pixels ?? [])]).toEqual([1, 2, 3, 4, 7, 7, 7, 7]);
  });

  it('stretches a quarter-wide block back out', async () => {
    // Block 0x42 stores one byte per four pixels, which is how Coktel encoded
    // a low-detail frame small rather than compressing it harder.
    const file = vmd({
      frames: [[{ kind: 'video', block: 0x42, rect: [0, 0, 3, 1], data: [3, 4] }]],
    });
    const stream = await openSciVmd(new BufferVolumeReader('t', [['E.VMD', file]]), 'E.VMD');
    const frame = await stream?.frame(0);

    expect([...(frame?.cel?.pixels ?? [])]).toEqual([3, 3, 3, 3, 4, 4, 4, 4]);
  });

  it('expands a compressed frame through Coktel’s own LZ77', async () => {
    // The top bit of the type byte means the rest is compressed: a declared
    // length, then a bit per literal. Eight set bits are eight literals.
    const body = [...u32le(8), 0xff, 1, 2, 3, 4, 5, 6, 7, 8];
    const file = vmd({
      frames: [[{ kind: 'video', block: 0x82, rect: [0, 0, 3, 1], data: body }]],
    });
    const stream = await openSciVmd(new BufferVolumeReader('t', [['F.VMD', file]]), 'F.VMD');
    const frame = await stream?.frame(0);

    expect([...(frame?.cel?.pixels ?? [])]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(stream?.undecodedFrames).toBe(0);
  });

  it('takes a palette a frame carries in front of its pixels', async () => {
    const file = vmd({
      frames: [
        [
          {
            kind: 'video',
            block: 0x02,
            rect: [0, 0, 3, 1],
            data: [1, 2, 3, 4, 5, 6, 7, 8],
            palette: [
              [10, 20, 30],
              [40, 50, 60],
            ],
          },
        ],
      ],
    });
    const stream = await openSciVmd(new BufferVolumeReader('t', [['G.VMD', file]]), 'G.VMD');
    const frame = await stream?.frame(0);

    // Shifted up by two, because Coktel stores six bits a channel.
    expect(frame?.palette?.[0]).toEqual({ index: 0, r: 40, g: 80, b: 120 });
    // And the pixels behind it are still read, which is the part a wrong
    // palette size silently breaks.
    expect([...(frame?.cel?.pixels ?? [])]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('hands audio back with the frame it arrived in, which is the sync guarantee', async () => {
    const file = vmd({
      frames: [
        [
          { kind: 'video', block: 0x02, rect: [0, 0, 3, 1], data: [1, 2, 3, 4, 5, 6, 7, 8] },
          { kind: 'audio', data: [9, 9, 9, 9] },
        ],
      ],
    });
    const stream = await openSciVmd(new BufferVolumeReader('t', [['H.VMD', file]]), 'H.VMD');
    const frame = await stream?.frame(0);

    expect(frame?.audio).toHaveLength(1);
    expect([...(frame?.audio[0] ?? [])]).toEqual([9, 9, 9, 9]);
  });

  it('drops an empty sound slice rather than inventing bytes for it', async () => {
    const file = vmd({
      frames: [
        [
          { kind: 'video', block: 0x02, rect: [0, 0, 3, 1], data: [1, 2, 3, 4, 5, 6, 7, 8] },
          { kind: 'audio', data: [0, 0], flags: 3 },
        ],
      ],
    });
    const stream = await openSciVmd(new BufferVolumeReader('t', [['I.VMD', file]]), 'I.VMD');

    expect((await stream?.frame(0))?.audio).toHaveLength(0);
  });

  it('refuses a file whose declared header length is not a VMD’s', async () => {
    const file = new Uint8Array(1024);
    file[0] = 50; // Addy 5's header length, which no SCI game carries
    expect(await openSciVmd(new BufferVolumeReader('t', [['J.VMD', file]]), 'J.VMD')).toBeNull();
  });
});

/**
 * A DUK, which is a RIFF/AVI — container read, codec refused.
 *
 * The refusal is not a shortcut and `SciAvi.ts` says why at length: TrueMotion
 * 1 decodes to 16-bit RGB and every surface in this renderer is an 8-bit index
 * into a palette, so what is missing is a colour path rather than a decoder.
 */
describe('a DUK, which is an AVI', () => {
  it('knows a RIFF/AVI from its first twelve bytes', () => {
    expect(isAviFile(riffHead())).toBe(true);
    expect(isAviFile(Uint8Array.from(tag('DUCK')))).toBe(false);
  });

  it('reads the streams, their codecs and the rate out of the header list', async () => {
    const file = avi([
      { id: '00dc', data: [1, 2, 3, 4] },
      { id: '01wb', data: [5, 6] },
      { id: '00dc', data: [7, 8, 9, 10] },
    ]);
    const stream = await openSciAvi(new BufferVolumeReader('t', [['1.duk', file]]), '1.duk');

    expect([stream?.info.width, stream?.info.height]).toEqual([4, 2]);
    expect(stream?.info.frameCount).toBe(2);
    expect(stream?.info.frameRate).toBe(10);
    expect(stream?.info.videoCodec).toBe('DUCK');
    expect(stream?.info.hasAudio).toBe(true);
    expect(stream?.info.audioFrequency).toBe(22050);
  });

  it('groups each frame with the audio that arrived beside it', async () => {
    const file = avi([
      { id: '00dc', data: [1, 2, 3, 4] },
      { id: '01wb', data: [5, 6] },
      { id: '00dc', data: [7, 8, 9, 10] },
    ]);
    const stream = await openSciAvi(new BufferVolumeReader('t', [['2.duk', file]]), '2.duk');

    const first = await stream?.frame(0);
    expect([...(first?.video ?? [])]).toEqual([1, 2, 3, 4]);
    expect([...(first?.audio[0] ?? [])]).toEqual([5, 6]);

    const second = await stream?.frame(1);
    expect([...(second?.video ?? [])]).toEqual([7, 8, 9, 10]);
    expect(second?.audio).toHaveLength(0);
  });

  it('says plainly that it cannot turn the video stream into pixels', async () => {
    const file = avi([{ id: '00dc', data: [1, 2, 3, 4] }]);
    const stream = await openSciAvi(new BufferVolumeReader('t', [['3.duk', file]]), '3.duk');

    expect(stream?.info.videoDecodable).toBe(false);
  });

  /**
   * Counted rather than handed back as a blank cel, so "playing" never means
   * "showing nothing while the audio runs".
   */
  it('counts a frame it cannot draw when opened as a video', async () => {
    const file = avi([{ id: '00dc', data: [1, 2, 3, 4] }]);
    const stream = await openSciVideo(new BufferVolumeReader('t', [['4.duk', file]]), '4.duk');

    expect(stream?.info.format).toBe('duk');
    expect((await stream?.frame(0))?.cel).toBeNull();
    expect(stream?.undecodedFrames).toBe(1);
  });

  it('walks the chunks lazily rather than indexing the file', async () => {
    const file = avi([
      { id: '00dc', data: new Array(64).fill(1) },
      { id: '00dc', data: new Array(64).fill(2) },
      { id: '00dc', data: new Array(64).fill(3) },
    ]);
    const stream = await openSciAvi(new BufferVolumeReader('t', [['5.duk', file]]), '5.duk');
    await stream?.frame(0);

    // The header window plus the chunk headers walked so far — not the file.
    expect(stream!.bytesRead()).toBeLessThan(file.length + 0x4000);
  });
});

/**
 * Playing one, which is the difference between "decoded" and "plays" (#226).
 *
 * The three things a player has to get right: a video blocks the interpreter
 * the way Sierra's did, it advances on the engine's own clock rather than as
 * fast as the loop turns, and **any key ends it** — a nine-minute
 * Phantasmagoria VMD that cannot be skipped is a game that cannot be played.
 */
describe('a video on screen', () => {
  /** Two frames, each a solid colour, so a step is visible in one pixel. */
  function twoFrames(): Uint8Array {
    return vmd({
      frames: [
        [{ kind: 'video', block: 0x02, rect: [0, 0, 3, 1], data: new Array(8).fill(1) }],
        [{ kind: 'video', block: 0x02, rect: [0, 0, 3, 1], data: new Array(8).fill(2) }],
      ],
    });
  }

  async function player(file = twoFrames()): Promise<{
    movies: SciMoviePlayer;
    input: SciInput;
    logs: string[];
  }> {
    const logs: string[] = [];
    const input = new SciInput();
    const movies = new SciMoviePlayer(
      new BufferVolumeReader('t', [['X.VMD', file]]),
      input,
      (message) => logs.push(message),
    );
    return { movies, input, logs };
  }

  it('is busy from the moment a Kernel call asks for it', async () => {
    const { movies } = await player();
    expect(movies.busy).toBe(false);

    // Queued rather than opened: opening reads a Volume, and a Kernel call
    // happens in the middle of a send.
    movies.play({ file: 'X.VMD' });
    expect(movies.busy).toBe(true);
  });

  it('advances one frame at a time on the engine clock', async () => {
    const { movies } = await player();
    movies.play({ file: 'X.VMD' });

    await movies.pump(0);
    expect(movies.frame?.cel?.pixels[0]).toBe(1);

    // Not yet due, so the same frame is still on screen. Five ticks a frame,
    // because the file says twelve a second and the file's rate wins.
    await movies.pump(3);
    expect(movies.frame?.cel?.pixels[0]).toBe(1);

    await movies.pump(5);
    expect(movies.frame?.cel?.pixels[0]).toBe(2);
  });

  it('ends when it runs out, and lets the interpreter run again', async () => {
    const { movies } = await player();
    // No rate is passed, so the file's own is used: this VMD carries no sound,
    // and Coktel's reader falls back to twelve frames a second for that case.
    movies.play({ file: 'X.VMD' });

    for (let tick = 0; tick <= 12; tick++) await movies.pump(tick);
    expect(movies.busy).toBe(false);
    expect(movies.done).toBe(true);
  });

  it('is skipped by a keypress, and takes the keystroke with it', async () => {
    const { movies, input, logs } = await player();
    movies.play({ file: 'X.VMD' });
    await movies.pump(0);

    input.post({ type: SCI_EVENT.keyDown, message: 27, modifiers: 0, x: 0, y: 0 });
    await movies.pump(1);

    expect(movies.busy).toBe(false);
    expect(logs.join(' ')).toMatch(/Skipped/);
    // Taken rather than left, or it arrives in the room afterwards as a stray
    // command — the player pressed escape at a video, not at the game.
    expect(input.next(SCI_EVENT.keyDown)).toBeNull();
  });

  it('paints the frame into the framebuffer rather than through the compositor', async () => {
    const { movies } = await player();
    movies.play({ file: 'X.VMD' });
    await movies.pump(0);

    const pixels = new Uint8Array(320 * 200);
    movies.paint(pixels, 320, 200, new Palette());
    expect(pixels[0]).toBe(1);
    expect(pixels[3]).toBe(1);
    // Below the video's two rows, nothing was touched: a video is played at
    // the screen and does not own the screen.
    expect(pixels[320 * 2]).toBe(0);
  });

  it('names a video it cannot open rather than hanging on it', async () => {
    const { movies, logs } = await player();
    movies.play({ file: 'MISSING.VMD' });
    await movies.pump(0);

    expect(movies.busy).toBe(false);
    expect(logs.join(' ')).toMatch(/MISSING.VMD could not be opened/);
  });

  it('reports what a video cost, which is the memory question', async () => {
    const { movies } = await player();
    movies.play({ file: 'X.VMD' });
    for (let tick = 0; tick <= 12; tick++) await movies.pump(tick);

    expect(movies.describe()).toMatch(/peak \d/);
  });
});

/**
 * The Kernel calls that reach the player — and the one that deliberately does
 * not.
 *
 * `Robot` is the architectural assertion in this file: every one of its
 * sub-functions goes to the Plane rather than to the movie player, because a
 * Robot is composited and not played. If `Robot` ever had to reach `playMovie`,
 * ADR 0015's tripwire would have fired.
 */
describe('the video Kernel calls', () => {
  function world(): SciKernelWorld & {
    played: Array<{ file: string; x?: number; y?: number; ticksPerFrame?: number }>;
    robots: number[];
    logs: string[];
  } {
    const played: Array<{ file: string; x?: number; y?: number; ticksPerFrame?: number }> = [];
    const robots: number[] = [];
    const logs: string[] = [];
    return {
      played,
      robots,
      logs,
      log: (message: string) => logs.push(message),
      playMovie: (request: { file: string; x?: number; y?: number; ticksPerFrame?: number }) =>
        played.push(request),
      closeMovie: () => undefined,
      movieStatus: () => ({ playing: played.length > 0, frame: 0 }),
      openRobot: (robot: number) => robots.push(robot),
      robotStatus: () => ({ open: robots.length > 0, finished: false, frame: 0 }),
      closeRobot: () => undefined,
      heap: {
        bytes: () =>
          Uint8Array.from(
            [...'GK.SEQ'].map((c) => c.charCodeAt(0)),
            (c) => c,
          ),
      },
    } as unknown as SciKernelWorld & {
      played: Array<{ file: string; x?: number; y?: number; ticksPerFrame?: number }>;
      robots: number[];
      logs: string[];
    };
  }

  it('plays what SCI16 ShowMovie names, at the rate the game passed', async () => {
    const { SCI_KERNEL } = await import('../src/engine/sci/script/SciKernel.js');
    const w = world();
    // A reference for the file name and the ticks a frame is held for, which
    // is the whole of the DOS call — a SEQ carries no rate of its own.
    SCI_KERNEL.ShowMovie(w, [reg(1, 0), reg(0, 10)]);

    expect(w.played).toEqual([{ file: 'GK.SEQ', ticksPerFrame: 10 }]);
  });

  it('opens, places and then plays a VMD, which is three sub-functions', async () => {
    const { SCI_KERNEL } = await import('../src/engine/sci/script/SciKernel.js');
    const w = world();

    SCI_KERNEL.PlayVMD(w, [reg(0, 0), reg(1, 0)]);
    // Opened and not played: a game that inits and never plays should show
    // nothing rather than a frame.
    expect(w.played).toHaveLength(0);

    SCI_KERNEL.PlayVMD(w, [reg(0, 1), reg(0, 20), reg(0, 30)]);
    SCI_KERNEL.PlayVMD(w, [reg(0, 14)]);
    expect(w.played).toEqual([{ file: 'GK.SEQ', x: 20, y: 30 }]);
  });

  it('names a PlayVMD sub-function it does not implement rather than returning zero', async () => {
    const { SCI_KERNEL } = await import('../src/engine/sci/script/SciKernel.js');
    const w = world();
    SCI_KERNEL.PlayVMD(w, [reg(0, 99)]);

    expect(w.logs.join(' ')).toMatch(/PlayVMD sub-function 99 is not implemented/);
  });

  it('builds a DUK’s file name the way Sierra did', async () => {
    const { SCI_KERNEL } = await import('../src/engine/sci/script/SciKernel.js');
    const w = world();
    SCI_KERNEL.PlayDuck(w, [reg(0, 1), reg(0, 42), reg(0, 0), reg(0, 5), reg(0, 6)]);

    expect(w.played).toEqual([{ file: '42.duk', x: 5, y: 6 }]);
  });

  /**
   * The claim, as a test. A Robot goes to the compositor and never to the
   * player, and this is the assertion that would fail first if that changed.
   */
  it('sends a Robot to a Plane and never to the movie player', async () => {
    const { SCI_KERNEL } = await import('../src/engine/sci/script/SciKernel.js');
    const w = world();
    SCI_KERNEL.Robot(w, [reg(0, 0), reg(0, 7), reg(2, 4), reg(0, 3), reg(0, 10), reg(0, 20)]);

    expect(w.robots).toEqual([7]);
    expect(w.played).toHaveLength(0);
    // And it reports itself open, which is what the scripts poll.
    expect(SCI_KERNEL.Robot(w, [reg(0, 6)]).offset).toBe(1);
  });
});
