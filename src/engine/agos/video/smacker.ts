/**
 * Smacker: the video container The Feeble Files and the Puzzle Pack play.
 *
 * ## Why this is here rather than in the VGA script machine
 *
 * `CONTEXT.md` draws the line for SCUMM — SMUSH is "played by the Engine
 * rather than decoded to a resource" — and `sciVideo.ts` draws it again for
 * SEQ, VMD and DUK. AGOS 2 is the same situation a third time. Nothing in the
 * VGA script machine is shaped for a video: that machine schedules sprites,
 * and a video is not one. So a `.smk` is played **at** the screen by
 * `AgosVideoPlayback`, and the game Subroutine's whole contribution is to name
 * the file (`off_loadVideo`) and say go (`off_playVideo`).
 *
 * ## Why Smacker and not DXA
 *
 * ScummVM's AGOS engine reads two things: RAD Game Tools' **Smacker**, which is
 * what Adventure Soft shipped on the discs, and **DXA**, which is ScummVM's own
 * re-encode of those files distributed for its ports. ADR 0024 settled which of
 * those this project reads and why: "read what the publisher shipped rather
 * than another implementation's derivation of it". A DXA is identified by name
 * here — so a player who has one is told what they have — and it is not
 * decoded.
 *
 * ## What the format is
 *
 * A fixed header, a table of frame sizes, a table of frame types, four Huffman
 * trees shared by every frame, and then the frames. A frame is a palette record
 * (sometimes), up to seven audio chunks (sometimes) and a block-coded picture
 * that is a **difference against the frame before it** — which is why this
 * reader owns a canvas and plays forward rather than pretending a frame decodes
 * on its own.
 *
 * The picture is 4x4 blocks, each block described by a code from the **type**
 * tree that carries both what the block is and how many blocks like it follow.
 * Four kinds: two colours and a 4x4 bitmask (mono), sixteen pixels straight out
 * of the **full** tree, one solid colour carried in the type code itself, and
 * skip, which leaves the previous frame's pixels alone.
 *
 * ## The trees, and the three values they remember
 *
 * Each of the four trees is a 16-bit tree built out of two 8-bit trees — one
 * for the low byte of a value, one for the high — plus three **markers**. A
 * leaf whose value equals a marker is not that value: it is a slot holding one
 * of the three most recently decoded values, moved up as they are used. That
 * makes a repeated value cost one short code instead of two byte codes, and it
 * is the reason a tree cannot be decoded once and treated as a lookup table:
 * `codeFrom` writes back into the tree as it reads.
 *
 * The three slots are cleared at the start of every frame, which is what makes
 * a keyframe decodable without the frames before it.
 *
 * ## Where this reading comes from, and where the two references disagree
 *
 * Written against ScummVM's `video/smk_decoder.cpp` and FFmpeg's
 * `libavcodec/smacker.c`, which agree everywhere except one place: the order in
 * which a **full block in mode 2** reads its two codes. FFmpeg reads the code
 * for the right-hand pair first, matching what both agree on for mode 0;
 * ScummVM reads the left-hand pair first. FFmpeg's reading is taken here
 * because it is the one consistent with mode 0.
 *
 * **Nothing this project can obtain settles it**, and that is now measured
 * rather than supposed: modes 1 and 2 are Smacker 4 only, and all 71 files in
 * The Feeble Files' demo are Smacker 2. So the two modes are written from the
 * references and reached by no game data anybody here has — which is a smaller
 * and more honest claim than the rest of this file makes.
 *
 * ## What this has been run against
 *
 * The 71 `.smk` files The Feeble Files' DOS demo ships — 208 MB of Adventure
 * Soft's own video, fetched with `npm run fetch:agos`. All 71 opened, all
 * Smacker 2, **15,961 frames decoded, 1,459 palette changes and 14,741 audio
 * chunks**, with no frame throwing and none short.
 *
 * The strongest check the container offers passed on every one of them: walking
 * the frame-size table from the end of the trees lands **exactly on the end of
 * the file**, to the byte, in all 71. That is the same standard `SciSeq`
 * applies to SEQ, and it is worth more than a fixture can give — a fixture
 * agrees with the reader by construction, and these files were written by RAD's
 * encoder in 1997.
 *
 * Frames from three of them were rendered and looked at, which is the Tier 2
 * claim `docs/processes/verifying-version-support.md` says cannot be automated:
 * correct geometry, correct colours, and burned-in subtitles legible.
 */

/** A tree node's marker bit, in the 8-bit trees. */
const SMALL_NODE = 0x8000;
/** A tree node's marker bit, in the 16-bit trees. */
const BIG_NODE = 0x80000000;

/** The four block kinds, in the low two bits of a type code. */
const BLOCK_MONO = 0;
const BLOCK_FULL = 1;
const BLOCK_SKIP = 2;
const BLOCK_FILL = 3;

/**
 * Six-bit palette components, widened to eight.
 *
 * Not `value * 4`, which is what a reader writes when it assumes VGA: Smacker's
 * own table is not linear at the top, and the difference shows as a picture
 * that is very slightly dark in its brightest colours — the fault class
 * `docs/processes/verifying-version-support.md` is most insistent about,
 * because everything else looks right.
 */
const PALETTE_SCALE = Uint8Array.from([
  0x00, 0x04, 0x08, 0x0c, 0x10, 0x14, 0x18, 0x1c, 0x20, 0x24, 0x28, 0x2c, 0x30, 0x34, 0x38, 0x3c,
  0x41, 0x45, 0x49, 0x4d, 0x51, 0x55, 0x59, 0x5d, 0x61, 0x65, 0x69, 0x6d, 0x71, 0x75, 0x79, 0x7d,
  0x82, 0x86, 0x8a, 0x8e, 0x92, 0x96, 0x9a, 0x9e, 0xa2, 0xa6, 0xaa, 0xae, 0xb2, 0xb6, 0xba, 0xbe,
  0xc3, 0xc7, 0xcb, 0xcf, 0xd3, 0xd7, 0xdb, 0xdf, 0xe3, 0xe7, 0xeb, 0xef, 0xf3, 0xf7, 0xfb, 0xff,
]);

/**
 * How many blocks a type code's run field means.
 *
 * One to fifty-nine counted directly, and then five powers of two — so a frame
 * that skips two thousand blocks spends one code rather than thirty-four.
 */
function blockRun(index: number): number {
  if (index < 59) return index + 1;
  return [128, 256, 512, 1024, 2048][index - 59] ?? 1;
}

/**
 * Bits, least significant first within each byte.
 *
 * The order is the one thing about Smacker that cannot be inferred from a file:
 * read it the other way round and the first tree decodes to nonsense, which at
 * least fails loudly rather than quietly.
 */
class BitReader {
  private byteAt = 0;
  private bitAt = 0;

  constructor(private readonly data: Uint8Array) {}

  get exhausted(): boolean {
    return this.byteAt >= this.data.length;
  }

  bit(): number {
    const byte = this.data[this.byteAt] ?? 0;
    const value = (byte >> this.bitAt) & 1;
    this.bitAt += 1;
    if (this.bitAt === 8) {
      this.bitAt = 0;
      this.byteAt += 1;
    }
    return value;
  }

  bits(count: number): number {
    let value = 0;
    for (let index = 0; index < count; index += 1) value |= this.bit() << index;
    return value >>> 0;
  }
}

/**
 * An 8-bit Huffman tree, held flat.
 *
 * A leaf holds its value; an internal node holds `SMALL_NODE` plus the size of
 * its left subtree, so the right child is found by stepping over it. Flat
 * because that is the shape the format's own decoder uses and because walking
 * it is the decode — there is no separate code table to build.
 */
class SmallTree {
  private readonly nodes: number[] = [];

  constructor(bits: BitReader) {
    // A leading set bit, the tree, and a clear bit after it. The leading bit is
    // not a flag: every 8-bit tree in a Smacker file has one.
    bits.bit();
    this.build(bits);
    bits.bit();
  }

  private build(bits: BitReader): number {
    if (bits.bit() === 0) {
      this.nodes.push(bits.bits(8));
      return 1;
    }
    const at = this.nodes.length;
    this.nodes.push(0);
    const left = this.build(bits);
    this.nodes[at] = SMALL_NODE | left;
    const right = this.build(bits);
    return left + right + 1;
  }

  code(bits: BitReader): number {
    let at = 0;
    while (((this.nodes[at] ?? 0) & SMALL_NODE) !== 0) {
      if (bits.bit() === 1) at += (this.nodes[at] ?? 0) & ~SMALL_NODE;
      at += 1;
    }
    return this.nodes[at] ?? 0;
  }
}

/**
 * A 16-bit Huffman tree with three remembered values.
 *
 * `code` moves the value it just returned into the first remembered slot and
 * pushes the others down, which is why this is a mutable object rather than a
 * decoded table: the same bit pattern means different values at different
 * points in a frame, by design.
 */
class BigTree {
  private readonly nodes: number[] = [];
  /** Where the three remembered values live in `nodes`. */
  private readonly slots: number[] = [0, 0, 0];
  private markers: number[] = [-1, -1, -1];
  private found: number[] = [-1, -1, -1];

  constructor(bits: BitReader) {
    if (bits.bit() === 0) {
      // A tree the file declares empty. Every code out of it is zero, which is
      // a real thing for a video whose blocks are all one kind.
      this.nodes.push(0);
      return;
    }

    const low = new SmallTree(bits);
    const high = new SmallTree(bits);
    this.markers = [bits.bits(16), bits.bits(16), bits.bits(16)];
    this.build(bits, low, high);
    bits.bit();

    // A marker the tree never used still needs a slot, or the per-frame reset
    // would write into a leaf that means something.
    for (let index = 0; index < 3; index += 1) {
      if (this.found[index] === -1) {
        this.found[index] = this.nodes.length;
        this.nodes.push(0);
      }
      this.slots[index] = this.found[index]!;
    }
  }

  private build(bits: BitReader, low: SmallTree, high: SmallTree): number {
    if (bits.bit() === 0) {
      const value = low.code(bits) | (high.code(bits) << 8);
      const at = this.nodes.length;
      const marker = this.markers.indexOf(value);
      // A leaf whose value *is* a marker is a slot rather than that value, and
      // it starts empty. Matching on the value rather than on a flag is the
      // format's own rule and the reason markers are chosen to be values a
      // frame never legitimately carries.
      this.nodes.push(marker === -1 ? value : 0);
      if (marker !== -1 && this.found[marker] === -1) this.found[marker] = at;
      return 1;
    }
    const at = this.nodes.length;
    this.nodes.push(0);
    const left = this.build(bits, low, high);
    this.nodes[at] = (BIG_NODE | left) >>> 0;
    const right = this.build(bits, low, high);
    return left + right + 1;
  }

  /** Clears the three remembered values, which every frame starts with. */
  reset(): void {
    for (const slot of this.slots) this.nodes[slot] = 0;
  }

  code(bits: BitReader): number {
    let at = 0;
    while (((this.nodes[at] ?? 0) & BIG_NODE) !== 0) {
      if (bits.bit() === 1) at += (this.nodes[at] ?? 0) & ~BIG_NODE;
      at += 1;
    }
    const value = this.nodes[at] ?? 0;
    if (value !== this.nodes[this.slots[0]!]) {
      this.nodes[this.slots[2]!] = this.nodes[this.slots[1]!]!;
      this.nodes[this.slots[1]!] = this.nodes[this.slots[0]!]!;
      this.nodes[this.slots[0]!] = value;
    }
    return value;
  }
}

/** One audio track's format, as the header declares it. */
export interface SmackerAudioTrack {
  readonly present: boolean;
  readonly compressed: boolean;
  readonly sixteenBit: boolean;
  readonly stereo: boolean;
  readonly sampleRate: number;
}

/** What a Smacker file's header says, before a frame is decoded. */
export interface SmackerInfo {
  /** `2` or `4` — the two the format has, and both are read here. */
  readonly version: 2 | 4;
  readonly width: number;
  readonly height: number;
  /** The height a frame is displayed at, which doubles when the file says so. */
  readonly displayHeight: number;
  readonly frameCount: number;
  /** How long one frame is shown, in seconds. */
  readonly frameSeconds: number;
  readonly audio: readonly SmackerAudioTrack[];
}

/** Decoded audio from one frame, in the track it belongs to. */
export interface SmackerAudio {
  readonly track: number;
  readonly sampleRate: number;
  readonly channels: number;
  /** Interleaved, in the range -1..1, which is what the mixer takes. */
  readonly samples: Float32Array;
}

/** One decoded frame. */
export interface SmackerFrame {
  /** Palette indices, `width * height` of them. The canvas, not a copy. */
  readonly pixels: Uint8Array;
  /** 256 colours as RGB triples, whether or not this frame changed them. */
  readonly palette: Uint8Array;
  readonly paletteChanged: boolean;
  readonly audio: readonly SmackerAudio[];
}

function u32(data: Uint8Array, at: number): number {
  return (
    ((data[at] ?? 0) |
      ((data[at + 1] ?? 0) << 8) |
      ((data[at + 2] ?? 0) << 16) |
      ((data[at + 3] ?? 0) << 24)) >>>
    0
  );
}

function s32(data: Uint8Array, at: number): number {
  return u32(data, at) | 0;
}

/** Whether these bytes open like a Smacker file. */
export function looksLikeSmacker(data: Uint8Array): boolean {
  return (
    data.length > 104 &&
    data[0] === 0x53 &&
    data[1] === 0x4d &&
    data[2] === 0x4b &&
    (data[3] === 0x32 || data[3] === 0x34)
  );
}

/**
 * A Smacker file, opened and playable a frame at a time.
 *
 * Frames are decoded in order and only in order. `frame(n)` for an `n` already
 * passed replays from the start rather than pretending a difference frame
 * stands alone — the same rule `SciSeq` follows, for the same reason.
 */
export class Smacker {
  readonly info: SmackerInfo;

  private readonly frameSizes: number[] = [];
  private readonly frameTypes: number[] = [];
  private readonly firstFrameAt: number;

  private readonly mmap: BigTree;
  private readonly mclr: BigTree;
  private readonly full: BigTree;
  private readonly type: BigTree;

  /** The canvas frames are decoded into, carried between them. */
  private readonly canvas: Uint8Array;
  private readonly palette = new Uint8Array(768);
  private next = 0;

  private constructor(private readonly data: Uint8Array) {
    const version = data[3] === 0x34 ? 4 : 2;
    const width = u32(data, 4);
    const height = u32(data, 8);
    const declaredFrames = u32(data, 12);
    const rate = s32(data, 16);
    const flags = u32(data, 20);
    const treesSize = u32(data, 52);

    const audio: SmackerAudioTrack[] = [];
    for (let track = 0; track < 7; track += 1) {
      const word = u32(data, 72 + track * 4);
      audio.push({
        present: (word & 0x40000000) !== 0,
        compressed: (word & 0x80000000) !== 0,
        sixteenBit: (word & 0x20000000) !== 0,
        stereo: (word & 0x10000000) !== 0,
        sampleRate: word & 0xffffff,
      });
    }

    // A rate of zero means ten milliseconds, a positive one is milliseconds,
    // and a negative one is hundredths of a millisecond — three conventions in
    // one field, which is why this is arithmetic rather than a division.
    const milliseconds = rate > 0 ? rate : rate < 0 ? -rate / 100 : 100;

    // A ring frame is an extra frame at the end that loops back to the start.
    // It is in the tables and not in the count, which is a trap: reading the
    // tables by the count leaves the last frame's size unread and every offset
    // after the tables wrong.
    const ring = (flags & 1) !== 0;
    const tabled = declaredFrames + (ring ? 1 : 0);

    let at = 104;
    for (let index = 0; index < tabled; index += 1, at += 4) this.frameSizes.push(u32(data, at));
    for (let index = 0; index < tabled; index += 1, at += 1) this.frameTypes.push(data[at] ?? 0);

    const bits = new BitReader(data.subarray(at, at + treesSize));
    this.mmap = new BigTree(bits);
    this.mclr = new BigTree(bits);
    this.full = new BigTree(bits);
    this.type = new BigTree(bits);
    this.firstFrameAt = at + treesSize;

    this.canvas = new Uint8Array(width * height);
    this.info = {
      version,
      width,
      height,
      // Y-interlaced and Y-doubled both mean the same thing to a player: the
      // decoded picture is half the height it is shown at.
      displayHeight: (flags & 6) !== 0 ? height * 2 : height,
      frameCount: declaredFrames,
      frameSeconds: milliseconds / 1000,
      audio,
    };
  }

  /** Opens a file, or answers null when it is not a Smacker one. */
  static open(data: Uint8Array): Smacker | null {
    if (!looksLikeSmacker(data)) return null;
    try {
      return new Smacker(data);
    } catch {
      return null;
    }
  }

  /**
   * The next frame, decoded.
   *
   * Returns null past the end. A caller that wants to loop asks for frame zero
   * again through `rewind`, which is what a ring frame means.
   */
  nextFrame(): SmackerFrame | null {
    if (this.next >= this.info.frameCount) return null;
    return this.decodeFrame(this.next++);
  }

  /** Goes back to the start, so a video can be played twice. */
  rewind(): void {
    this.next = 0;
    this.canvas.fill(0);
  }

  private frameOffset(index: number): number {
    let at = this.firstFrameAt;
    for (let before = 0; before < index; before += 1) at += (this.frameSizes[before] ?? 0) & ~3;
    return at;
  }

  private decodeFrame(index: number): SmackerFrame {
    const start = this.frameOffset(index);
    const size = (this.frameSizes[index] ?? 0) & ~3;
    const kind = this.frameTypes[index] ?? 0;
    let at = start;

    let paletteChanged = false;
    if ((kind & 1) !== 0) {
      const chunk = (this.data[at] ?? 0) * 4;
      this.unpackPalette(this.data.subarray(at + 1, at + chunk));
      paletteChanged = true;
      at += chunk;
    }

    const audio: SmackerAudio[] = [];
    for (let track = 0; track < 7; track += 1) {
      if ((kind & (2 << track)) === 0) continue;
      const chunk = u32(this.data, at);
      const decoded = this.decodeAudio(track, this.data.subarray(at + 4, at + chunk));
      if (decoded) audio.push(decoded);
      at += chunk;
    }

    this.decodePicture(this.data.subarray(at, start + size));
    return { pixels: this.canvas, palette: this.palette, paletteChanged, audio };
  }

  /**
   * A palette record: skip, copy from the old palette, or three new components.
   *
   * The copy case reads the palette this record is replacing, which means the
   * old one has to be kept whole while the new one is built — a palette written
   * in place produces colours copied from entries already overwritten, and the
   * result is a picture whose colours are almost right.
   */
  private unpackPalette(chunk: Uint8Array): void {
    const old = this.palette.slice();
    this.palette.fill(0);
    let read = 0;
    let entry = 0;
    while (entry < 256 && read < chunk.length) {
      const control = chunk[read++] ?? 0;
      if ((control & 0x80) !== 0) {
        entry += (control & 0x7f) + 1;
      } else if ((control & 0x40) !== 0) {
        let from = (chunk[read++] ?? 0) * 3;
        for (let count = (control & 0x3f) + 1; count > 0 && entry < 256; count -= 1) {
          this.palette[entry * 3] = old[from] ?? 0;
          this.palette[entry * 3 + 1] = old[from + 1] ?? 0;
          this.palette[entry * 3 + 2] = old[from + 2] ?? 0;
          from += 3;
          entry += 1;
        }
      } else {
        this.palette[entry * 3] = PALETTE_SCALE[control & 0x3f] ?? 0;
        this.palette[entry * 3 + 1] = PALETTE_SCALE[(chunk[read++] ?? 0) & 0x3f] ?? 0;
        this.palette[entry * 3 + 2] = PALETTE_SCALE[(chunk[read++] ?? 0) & 0x3f] ?? 0;
        entry += 1;
      }
    }
  }

  private decodePicture(body: Uint8Array): void {
    for (const tree of [this.mmap, this.mclr, this.full, this.type]) tree.reset();

    const bits = new BitReader(body);
    const across = Math.floor((this.info.width + 3) / 4);
    const down = Math.floor((this.info.height + 3) / 4);
    const blocks = across * down;
    const stride = this.info.width;

    let block = 0;
    // Bits running out before the blocks do is a truncated frame, and stopping
    // leaves the rest of the canvas as the previous frame had it. The
    // alternative — reading zeros past the end — would invent pixels, which is
    // the one thing `docs/processes/verifying-version-support.md` is most
    // insistent about not doing.
    while (block < blocks && !bits.exhausted) {
      const type = this.type.code(bits);
      let run = blockRun((type >> 2) & 0x3f);

      switch (type & 3) {
        case BLOCK_MONO:
          while (run-- > 0 && block < blocks) {
            const colours = this.mclr.code(bits);
            let map = this.mmap.code(bits);
            const low = colours & 0xff;
            const high = colours >> 8;
            let out = Math.floor(block / across) * 4 * stride + (block % across) * 4;
            for (let row = 0; row < 4; row += 1) {
              for (let column = 0; column < 4; column += 1) {
                this.canvas[out + column] = (map & (1 << column)) !== 0 ? high : low;
              }
              map >>= 4;
              out += stride;
            }
            block += 1;
          }
          break;

        case BLOCK_FULL: {
          // Smacker 2 has one way to write a full block; Smacker 4 added two
          // more and spends up to two bits saying which.
          let mode = 0;
          if (this.info.version === 4) mode = bits.bit() === 1 ? (bits.bit() === 1 ? 2 : 1) : 0;
          while (run-- > 0 && block < blocks) {
            let out = Math.floor(block / across) * 4 * stride + (block % across) * 4;
            if (mode === 0) {
              for (let row = 0; row < 4; row += 1) {
                // The right-hand pair first, which is the format's order and
                // not a transcription slip.
                const right = this.full.code(bits);
                this.canvas[out + 2] = right & 0xff;
                this.canvas[out + 3] = right >> 8;
                const left = this.full.code(bits);
                this.canvas[out] = left & 0xff;
                this.canvas[out + 1] = left >> 8;
                out += stride;
              }
            } else if (mode === 1) {
              for (let pair = 0; pair < 2; pair += 1) {
                const pixels = this.full.code(bits);
                for (let row = 0; row < 2; row += 1) {
                  this.canvas[out] = pixels & 0xff;
                  this.canvas[out + 1] = pixels & 0xff;
                  this.canvas[out + 2] = pixels >> 8;
                  this.canvas[out + 3] = pixels >> 8;
                  out += stride;
                }
              }
            } else {
              for (let pair = 0; pair < 2; pair += 1) {
                const right = this.full.code(bits);
                const left = this.full.code(bits);
                for (let row = 0; row < 2; row += 1) {
                  this.canvas[out] = left & 0xff;
                  this.canvas[out + 1] = left >> 8;
                  this.canvas[out + 2] = right & 0xff;
                  this.canvas[out + 3] = right >> 8;
                  out += stride;
                }
              }
            }
            block += 1;
          }
          break;
        }

        case BLOCK_SKIP:
          // The whole reason the canvas is kept: a skipped block is the
          // previous frame's pixels, unchanged.
          while (run-- > 0 && block < blocks) block += 1;
          break;

        case BLOCK_FILL: {
          // The colour is in the type code itself rather than in a tree, which
          // is what makes a flat area of a frame nearly free.
          const colour = (type >> 8) & 0xff;
          while (run-- > 0 && block < blocks) {
            let out = Math.floor(block / across) * 4 * stride + (block % across) * 4;
            for (let row = 0; row < 4; row += 1) {
              this.canvas.fill(colour, out, out + 4);
              out += stride;
            }
            block += 1;
          }
          break;
        }
      }
    }
  }

  /**
   * One audio chunk, compressed or not.
   *
   * Compressed audio is Huffman-coded **deltas** against a base sample the
   * chunk carries, one tree per byte of a sample per channel — so a 16-bit
   * stereo track has four. The base is also the first sample, which is easy to
   * drop and produces a click at the start of every chunk.
   */
  private decodeAudio(track: number, chunk: Uint8Array): SmackerAudio | null {
    const format = this.info.audio[track];
    if (!format || !format.present) return null;
    const channels = format.stereo ? 2 : 1;

    if (!format.compressed) {
      return {
        track,
        sampleRate: format.sampleRate,
        channels,
        samples: rawToFloat(chunk, format.sixteenBit),
      };
    }

    const unpacked = u32(chunk, 0);
    const bits = new BitReader(chunk.subarray(4));
    if (bits.bit() === 0) return null;

    // The chunk restates the format the header already gave. Where they
    // disagree the chunk is followed, because it is what the bits after it were
    // written for.
    const stereo = bits.bit() === 1;
    const sixteenBit = bits.bit() === 1;
    const lanes = (stereo ? 2 : 1) * (sixteenBit ? 2 : 1);
    const trees: SmallTree[] = [];
    for (let lane = 0; lane < lanes; lane += 1) trees.push(new SmallTree(bits));

    const bases = [0, 0];
    if (sixteenBit) {
      if (stereo) bases[1] = swap16(bits.bits(16));
      bases[0] = swap16(bits.bits(16));
    } else {
      if (stereo) bases[1] = bits.bits(8);
      bases[0] = bits.bits(8);
    }

    const step = sixteenBit ? 2 : 1;
    const total = Math.floor(unpacked / step);
    const samples = new Float32Array(total);
    let written = 0;
    for (let channel = 0; channel < (stereo ? 2 : 1) && written < total; channel += 1) {
      samples[written++] = sixteenBit
        ? clampSigned(bases[channel]!) / 32768
        : ((bases[channel]! & 0xff) - 128) / 128;
    }

    while (written < total) {
      for (let channel = 0; channel < (stereo ? 2 : 1) && written < total; channel += 1) {
        if (sixteenBit) {
          const low = trees[channel * 2]!.code(bits);
          const high = trees[channel * 2 + 1]!.code(bits);
          const base = (bases[channel] ?? 0) + (((low | (high << 8)) << 16) >> 16);
          bases[channel] = base;
          samples[written++] = clampSigned(base) / 32768;
        } else {
          const delta = ((trees[channel]!.code(bits) ^ 0x80) << 24) >> 24;
          const base = Math.max(0, Math.min(255, (bases[channel] ?? 0) + delta));
          bases[channel] = base;
          samples[written++] = (base - 128) / 128;
        }
      }
      if (bits.exhausted) break;
    }

    return { track, sampleRate: format.sampleRate, channels, samples };
  }
}

function clampSigned(value: number): number {
  return Math.max(-32768, Math.min(32767, value));
}

function swap16(value: number): number {
  const swapped = ((value & 0xff) << 8) | ((value >> 8) & 0xff);
  return (swapped << 16) >> 16;
}

/** Raw PCM out of an uncompressed track, as the mixer's floats. */
function rawToFloat(chunk: Uint8Array, sixteenBit: boolean): Float32Array {
  if (!sixteenBit) {
    const samples = new Float32Array(chunk.length);
    for (let index = 0; index < chunk.length; index += 1) {
      samples[index] = ((chunk[index] ?? 0) - 128) / 128;
    }
    return samples;
  }
  const count = Math.floor(chunk.length / 2);
  const samples = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const word = (chunk[index * 2] ?? 0) | ((chunk[index * 2 + 1] ?? 0) << 8);
    samples[index] = ((word << 16) >> 16) / 32768;
  }
  return samples;
}
